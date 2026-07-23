// agent/src/sub-agent-kafka-yaml-drift.test.ts

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { ToolDefinitionSchema } from "@devops-agent/gitagent-bridge";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { parse } from "yaml";
import { selectToolsByAction } from "./sub-agent.ts";
import { TYPED_FINDING_TOOLS } from "./sub-agent-instrumentation.ts";

// SIO-1192 fixture-drift guard (audit SIO-1186): parse the REAL kafka-introspect.yaml so the
// shipped action map can never silently diverge from what the typed extractor / correlation
// rules depend on. Kafka has 61 server tools > MAX_TOOLS_PER_AGENT (25), so the action filter
// ALWAYS engages -- a tool that falls out of its expected group becomes genuinely unreachable
// for the extractor, not theoretically (the gitlab SIO-1178 incident class).
const yamlPath = new URL("../../../agents/incident-analyzer/tools/kafka-introspect.yaml", import.meta.url);
const parsed = ToolDefinitionSchema.parse(parse(readFileSync(yamlPath, "utf8")));
const actionMap = parsed.tool_mapping?.action_tool_map ?? {};
const allMapped = Object.values(actionMap).flat();

// Every extractor input (extractKafkaFindings) pinned to the action group whose selection the
// investigation depends on. kafka_describe_topic/kafka_get_topic_offsets (the SIO-1149 derived-DLQ
// fallback) are covered by topic_throughput/describe_topic.
const EXTRACTOR_INPUTS_BY_GROUP: Record<string, string[]> = {
	consumer_lag: ["kafka_list_consumer_groups", "kafka_get_consumer_group_lag"],
	dlq_messages: ["kafka_list_dlq_topics"],
	cluster_info: ["kafka_get_cluster_info", "kafka_describe_cluster"],
	connect_status: ["connect_list_connectors", "connect_get_connector_status"],
	ksql: ["ksql_list_queries"],
	topic_throughput: ["kafka_describe_topic", "kafka_get_topic_offsets"],
};

function fakeTools(names: string[]): StructuredToolInterface[] {
	return names.map((name) => ({ name }) as unknown as StructuredToolInterface);
}

describe("SIO-1192: kafka-introspect.yaml action map carries every extractor input", () => {
	test.each(Object.entries(EXTRACTOR_INPUTS_BY_GROUP))("%s group carries its extractor inputs", (group, tools) => {
		for (const tool of tools) {
			expect(actionMap[group]).toContain(tool);
		}
	});

	test("every kafka-domain TYPED_FINDING_TOOLS entry is mapped somewhere", () => {
		const kafkaDomain = Array.from(TYPED_FINDING_TOOLS).filter(
			(t) => t.startsWith("kafka_") || t.startsWith("connect_") || t.startsWith("ksql_"),
		);
		expect(kafkaDomain.length).toBeGreaterThan(0);
		for (const tool of kafkaDomain) {
			expect(allMapped).toContain(tool);
		}
	});
});

describe("SIO-1192: kafka resolution-set decision is executable documentation", () => {
	// Kafka is DELIBERATELY absent from RESOLUTION_TOOLS_BY_DATASOURCE (sub-agent.ts):
	// force-including kafka_list_topics would reintroduce the SIO-785 regression where the
	// broad listing tool crowds out the specialized dlq_messages tools. Identifier
	// resolution happens up-front in the resolveIdentifiers node instead. If this test
	// starts failing because a resolution entry was added, re-test the DLQ crowding
	// regression before accepting.
	test("dlq_messages selection is NOT force-augmented with resolution tools", () => {
		// Build the full real tool surface from the YAML map (61 names > the 25 cap).
		const allTools = fakeTools(Array.from(new Set(allMapped)));
		expect(allTools.length).toBeGreaterThan(25);
		const { tools, filtered } = selectToolsByAction(allTools, "kafka", { kafka: ["dlq_messages"] }, parsed);
		expect(filtered).toBe(true);
		const names = tools.map((t) => t.name);
		expect(names).toContain("kafka_list_dlq_topics");
		// No resolution force-include: the broad listing tool stays out of the narrow
		// dlq_messages budget (the SIO-785 protection this decision preserves).
		expect(names).not.toContain("kafka_list_topics");
	});

	test("consumer_lag selection keeps the kafka-significant-lag rule inputs reachable", () => {
		const allTools = fakeTools(Array.from(new Set(allMapped)));
		const { tools } = selectToolsByAction(allTools, "kafka", { kafka: ["consumer_lag"] }, parsed);
		const names = tools.map((t) => t.name);
		expect(names).toContain("kafka_list_consumer_groups");
		expect(names).toContain("kafka_get_consumer_group_lag");
		expect(tools.length).toBeLessThanOrEqual(25);
	});
});

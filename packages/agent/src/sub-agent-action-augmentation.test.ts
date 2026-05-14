// agent/src/sub-agent-action-augmentation.test.ts

import { describe, expect, test } from "bun:test";
import { matchActionsByKeywords, type ToolDefinition, ToolDefinitionSchema } from "@devops-agent/gitagent-bridge";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { inferClusterHealthActions, mergeKeywordActions, selectToolsByAction } from "./sub-agent.ts";

// Minimal kafka tool def fixture mirroring the real kafka-introspect.yaml's
// action_tool_map + action_keywords for restproxy and connect_status.
// Built via Zod parse so any future schema tightening (e.g. superRefine)
// catches drift between this fixture and the canonical schema.
const kafkaToolDef: ToolDefinition = ToolDefinitionSchema.parse({
	name: "kafka-introspect",
	description: "test fixture",
	input_schema: { type: "object", properties: {}, required: [] },
	tool_mapping: {
		mcp_server: "kafka",
		mcp_patterns: ["kafka_*", "ksql_*", "sr_*", "connect_*", "restproxy_*"],
		action_tool_map: {
			consumer_lag: ["kafka_list_consumer_groups", "kafka_describe_consumer_group", "kafka_get_consumer_group_lag"],
			cluster_info: ["kafka_get_cluster_info", "kafka_describe_cluster"],
			topic_throughput: ["kafka_list_topics", "kafka_describe_topic", "kafka_get_topic_offsets"],
			connect_status: [
				"connect_get_cluster_info",
				"connect_list_connectors",
				"connect_get_connector_status",
				"connect_get_connector_task_status",
			],
			restproxy: [
				"restproxy_list_topics",
				"restproxy_get_topic",
				"restproxy_get_partitions",
				"restproxy_produce",
				"restproxy_create_consumer",
			],
		},
		action_keywords: {
			connect_status: ["kafka connect", "connector", "connectors", "connect rest"],
			restproxy: ["rest proxy", "restproxy", "confluent rest"],
		},
	},
});

function fakeTools(names: string[]): StructuredToolInterface[] {
	return names.map((name) => ({ name }) as unknown as StructuredToolInterface);
}

// Build a tool list big enough that selectToolsByAction's filter path runs
// (MAX_TOOLS_PER_AGENT = 25; need allTools.length > 25 to trigger filtering).
function buildKafkaTools(): StructuredToolInterface[] {
	const filler = Array.from({ length: 26 }, (_, i) => `kafka_filler_${i}`);
	return fakeTools([
		...filler,
		"kafka_list_consumer_groups",
		"kafka_get_cluster_info",
		"restproxy_list_topics",
		"restproxy_get_topic",
		"connect_list_connectors",
		"connect_get_connector_status",
	]);
}

describe("SIO-738: keyword augmentation surfaces restproxy and connect tools", () => {
	test("includes a restproxy_* tool when the query mentions 'REST Proxy'", () => {
		const query = "check the kafka cluster and the REST Proxy health";
		const baseActions = ["consumer_lag", "cluster_info"]; // LLM omitted restproxy
		const keywordActions = matchActionsByKeywords(query, kafkaToolDef);
		expect(keywordActions).toContain("restproxy");

		const merged = mergeKeywordActions(baseActions, keywordActions);
		const allTools = buildKafkaTools();
		const { tools, filtered } = selectToolsByAction(allTools, "kafka", { kafka: merged }, kafkaToolDef);

		expect(filtered).toBe(true);
		const names = tools.map((t) => t.name);
		expect(names).toContain("restproxy_list_topics");
	});

	test("includes a connect_* tool when the query mentions 'Kafka Connect'", () => {
		const query = "are any kafka connect connectors failing?";
		const baseActions = ["consumer_lag"];
		const keywordActions = matchActionsByKeywords(query, kafkaToolDef);
		expect(keywordActions).toContain("connect_status");

		const merged = mergeKeywordActions(baseActions, keywordActions);
		const allTools = buildKafkaTools();
		const { tools, filtered } = selectToolsByAction(allTools, "kafka", { kafka: merged }, kafkaToolDef);

		expect(filtered).toBe(true);
		const names = tools.map((t) => t.name);
		expect(names.some((n) => n.startsWith("connect_"))).toBe(true);
	});

	test("returns no keyword actions when the query is narrow and uninvolved", () => {
		const query = "show me consumer lag for orders-consumer";
		const keywordActions = matchActionsByKeywords(query, kafkaToolDef);
		expect(keywordActions).toEqual([]);
	});

	test("does not duplicate actions the LLM already selected", () => {
		const query = "check REST Proxy and Kafka Connect health";
		const baseActions = ["restproxy", "connect_status"]; // LLM got it right
		const keywordActions = matchActionsByKeywords(query, kafkaToolDef);
		const merged = mergeKeywordActions(baseActions, keywordActions);
		// Order-insensitive equality
		expect(merged.sort()).toEqual(["connect_status", "restproxy"]);
	});
});

describe("SIO-742: inferClusterHealthActions auto-include for cluster-health queries", () => {
	const EXPECTED = ["health_check", "cluster_info", "restproxy", "ksql", "connect_status", "schema_registry"];

	test("matches 'how is my Kafka Cluster doing and the related services'", () => {
		const actions = inferClusterHealthActions(
			"How is my Kafka Cluster doing and the related services - KQSL, Connect, Schema Registry & Kafka Rest",
			"kafka",
		);
		expect(actions.sort()).toEqual([...EXPECTED].sort());
	});

	test("matches 'cluster health' phrasing", () => {
		const actions = inferClusterHealthActions("check the kafka cluster health overall", "kafka");
		expect(actions).toContain("health_check");
		expect(actions).toContain("restproxy");
	});

	test("matches 'Kafka Rest' substring (the SIO-742 root cause case)", () => {
		const actions = inferClusterHealthActions("is the Kafka Rest API up?", "kafka");
		expect(actions).toContain("restproxy");
		expect(actions).toContain("health_check");
	});

	test("matches 'Confluent Platform services'", () => {
		const actions = inferClusterHealthActions("status of the Confluent Platform services", "kafka");
		expect(actions).toContain("ksql");
		expect(actions).toContain("connect_status");
	});

	test("matches 'is X working' style probes", () => {
		const actions = inferClusterHealthActions("is ksql working and is rest proxy reachable", "kafka");
		expect(actions).toContain("ksql");
	});

	test("returns empty for unrelated kafka queries", () => {
		expect(inferClusterHealthActions("show consumer lag for orders-group", "kafka")).toEqual([]);
		expect(inferClusterHealthActions("list dlq topics", "kafka")).toEqual([]);
	});

	test("returns empty for non-kafka data sources", () => {
		expect(inferClusterHealthActions("how is my kafka cluster", "elastic")).toEqual([]);
		expect(inferClusterHealthActions("kafka rest", "gitlab")).toEqual([]);
	});

	test("returns empty for empty query", () => {
		expect(inferClusterHealthActions("", "kafka")).toEqual([]);
	});
});

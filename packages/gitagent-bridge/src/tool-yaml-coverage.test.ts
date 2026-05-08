// packages/gitagent-bridge/src/tool-yaml-coverage.test.ts
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { loadAgent } from "./index.ts";
import { getAllActionToolNames, getAvailableActions } from "./tool-mapping.ts";

const AGENTS_DIR = join(import.meta.dir, "../../../agents/incident-analyzer");

describe("kafka-introspect.yaml SIO-680/682 coverage", () => {
	test("declares 12 component-aligned actions", () => {
		const agent = loadAgent(AGENTS_DIR);
		const kafka = agent.tools.find((t) => t.name === "kafka-introspect");
		expect(kafka).toBeDefined();
		if (!kafka) return;
		const actions = getAvailableActions(kafka);
		expect(actions).toEqual([
			"consumer_lag",
			"topic_throughput",
			"dlq_messages",
			"cluster_info",
			"describe_topic",
			"schema_registry",
			"schema_management",
			"ksql",
			"connect_status",
			"connect_management",
			"restproxy",
			"write_ops",
		]);
	});

	test("covers all 55 unique MCP tool names across the action map", () => {
		const agent = loadAgent(AGENTS_DIR);
		const kafka = agent.tools.find((t) => t.name === "kafka-introspect");
		expect(kafka).toBeDefined();
		if (!kafka) return;
		const tools = getAllActionToolNames(kafka);
		expect(tools.length).toBe(55);
	});

	test("includes the SIO-680 Connect read tools under connect_status", () => {
		const agent = loadAgent(AGENTS_DIR);
		const kafka = agent.tools.find((t) => t.name === "kafka-introspect");
		expect(kafka).toBeDefined();
		if (!kafka) return;
		const map = kafka.tool_mapping?.action_tool_map;
		expect(map).toBeDefined();
		if (!map) return;
		expect(map.connect_status).toEqual([
			"connect_get_cluster_info",
			"connect_list_connectors",
			"connect_get_connector_status",
			"connect_get_connector_task_status",
		]);
	});

	test("includes the SIO-682 Connect writes/destructive under connect_management", () => {
		const agent = loadAgent(AGENTS_DIR);
		const kafka = agent.tools.find((t) => t.name === "kafka-introspect");
		expect(kafka).toBeDefined();
		if (!kafka) return;
		const map = kafka.tool_mapping?.action_tool_map;
		expect(map).toBeDefined();
		if (!map) return;
		expect(map.connect_management).toEqual([
			"connect_pause_connector",
			"connect_resume_connector",
			"connect_restart_connector",
			"connect_restart_connector_task",
			"connect_delete_connector",
		]);
	});

	test("includes the SIO-682 sr_* writes/destructive under schema_management", () => {
		const agent = loadAgent(AGENTS_DIR);
		const kafka = agent.tools.find((t) => t.name === "kafka-introspect");
		expect(kafka).toBeDefined();
		if (!kafka) return;
		const map = kafka.tool_mapping?.action_tool_map;
		expect(map).toBeDefined();
		if (!map) return;
		expect(map.schema_management).toEqual([
			"sr_register_schema",
			"sr_check_compatibility",
			"sr_set_compatibility",
			"sr_soft_delete_subject",
			"sr_soft_delete_subject_version",
			"sr_hard_delete_subject",
			"sr_hard_delete_subject_version",
		]);
	});

	test("includes all 9 REST Proxy tools under restproxy", () => {
		const agent = loadAgent(AGENTS_DIR);
		const kafka = agent.tools.find((t) => t.name === "kafka-introspect");
		expect(kafka).toBeDefined();
		if (!kafka) return;
		const map = kafka.tool_mapping?.action_tool_map;
		expect(map).toBeDefined();
		if (!map) return;
		expect(map.restproxy).toEqual([
			"restproxy_list_topics",
			"restproxy_get_topic",
			"restproxy_get_partitions",
			"restproxy_produce",
			"restproxy_create_consumer",
			"restproxy_subscribe",
			"restproxy_consume",
			"restproxy_commit_offsets",
			"restproxy_delete_consumer",
		]);
	});

	test("declares version 2.0.0 and honest annotations", () => {
		const agent = loadAgent(AGENTS_DIR);
		const kafka = agent.tools.find((t) => t.name === "kafka-introspect");
		expect(kafka).toBeDefined();
		if (!kafka) return;
		expect(kafka.version).toBe("2.0.0");
		expect(kafka.annotations?.read_only).toBe(false);
		expect(kafka.annotations?.requires_confirmation).toBe(true);
	});

	test("declares the new mcp_patterns covering sr_*, connect_*, restproxy_*", () => {
		const agent = loadAgent(AGENTS_DIR);
		const kafka = agent.tools.find((t) => t.name === "kafka-introspect");
		expect(kafka).toBeDefined();
		if (!kafka) return;
		const patterns = kafka.tool_mapping?.mcp_patterns;
		expect(patterns).toBeDefined();
		if (!patterns) return;
		expect(patterns).toEqual(["kafka_*", "ksql_*", "sr_*", "connect_*", "restproxy_*"]);
	});

	test("preserves the existing action enum entries (no regression)", () => {
		const agent = loadAgent(AGENTS_DIR);
		const kafka = agent.tools.find((t) => t.name === "kafka-introspect");
		expect(kafka).toBeDefined();
		if (!kafka) return;
		const map = kafka.tool_mapping?.action_tool_map;
		expect(map).toBeDefined();
		if (!map) return;
		expect(map.consumer_lag).toContain("kafka_list_consumer_groups");
		expect(map.topic_throughput).toContain("kafka_describe_topic");
		expect(map.schema_registry).toContain("kafka_list_schemas");
		expect(map.ksql).toContain("ksql_run_query");
		expect(map.write_ops).toContain("kafka_delete_topic");
	});

	test("declares action_descriptions for all 12 actions, each non-empty", () => {
		const agent = loadAgent(AGENTS_DIR);
		const kafka = agent.tools.find((t) => t.name === "kafka-introspect");
		expect(kafka).toBeDefined();
		if (!kafka) return;
		const descriptions = kafka.tool_mapping?.action_descriptions;
		expect(descriptions).toBeDefined();
		if (!descriptions) return;
		const actionKeys = Object.keys(kafka.tool_mapping?.action_tool_map ?? {});
		for (const action of actionKeys) {
			expect(descriptions[action]).toBeDefined();
			expect((descriptions[action] ?? "").length).toBeGreaterThan(20);
		}
		expect(Object.keys(descriptions).length).toBe(12);
	});
});

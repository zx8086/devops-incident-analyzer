// packages/gitagent-bridge/src/tool-yaml-coverage.test.ts
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { loadAgent } from "./index.ts";
import { getAllActionToolNames, getAvailableActions } from "./tool-mapping.ts";

const AGENTS_DIR = join(import.meta.dir, "../../../agents/incident-analyzer");

describe("kafka-introspect.yaml SIO-680/682 coverage", () => {
	test("declares 13 component-aligned actions (SIO-742 added health_check)", () => {
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
			"health_check",
			"write_ops",
		]);
	});

	test("covers all 61 unique MCP tool names across the action map (SIO-742 +5 health-check, SIO-770 +kafka_list_dlq_topics)", () => {
		const agent = loadAgent(AGENTS_DIR);
		const kafka = agent.tools.find((t) => t.name === "kafka-introspect");
		expect(kafka).toBeDefined();
		if (!kafka) return;
		const tools = getAllActionToolNames(kafka);
		expect(tools.length).toBe(61);
	});

	test("includes the SIO-680 Connect read tools under connect_status (SIO-742 prepends connect_health_check)", () => {
		const agent = loadAgent(AGENTS_DIR);
		const kafka = agent.tools.find((t) => t.name === "kafka-introspect");
		expect(kafka).toBeDefined();
		if (!kafka) return;
		const map = kafka.tool_mapping?.action_tool_map;
		expect(map).toBeDefined();
		if (!map) return;
		expect(map.connect_status).toEqual([
			"connect_health_check",
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

	test("includes all 10 REST Proxy tools under restproxy (SIO-742 prepends restproxy_health_check)", () => {
		const agent = loadAgent(AGENTS_DIR);
		const kafka = agent.tools.find((t) => t.name === "kafka-introspect");
		expect(kafka).toBeDefined();
		if (!kafka) return;
		const map = kafka.tool_mapping?.action_tool_map;
		expect(map).toBeDefined();
		if (!map) return;
		expect(map.restproxy).toEqual([
			"restproxy_health_check",
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

	test("declares action_descriptions for all 13 actions, each non-empty (SIO-742 adds health_check)", () => {
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
		expect(Object.keys(descriptions).length).toBe(13);
	});
});

describe("sibling tool YAMLs action_descriptions coverage (SIO-680/682 follow-up)", () => {
	const SIBLING_FACADES = [
		"elastic-search-logs",
		"couchbase-cluster-health",
		"konnect-api-gateway",
		"gitlab-api",
		"atlassian-api",
	] as const;

	for (const facadeName of SIBLING_FACADES) {
		test(`${facadeName} declares action_descriptions for every action_tool_map key`, () => {
			const agent = loadAgent(AGENTS_DIR);
			const tool = agent.tools.find((t) => t.name === facadeName);
			expect(tool).toBeDefined();
			if (!tool) return;
			const map = tool.tool_mapping?.action_tool_map;
			const descriptions = tool.tool_mapping?.action_descriptions;
			expect(map).toBeDefined();
			expect(descriptions).toBeDefined();
			if (!map || !descriptions) return;
			const actionKeys = Object.keys(map);
			for (const action of actionKeys) {
				expect(descriptions[action]).toBeDefined();
				expect((descriptions[action] ?? "").length).toBeGreaterThan(20);
			}
			expect(Object.keys(descriptions).length).toBe(actionKeys.length);
		});
	}
});

describe("couchbase-health.yaml query-diagnosis chaining coverage (SIO-1137)", () => {
	// Every action group whose tools return query statement text must also carry
	// the tools to diagnose those statements (EXPLAIN + Index Advisor), so the
	// sub-agent can check indexes on statements that surface mid-investigation.
	const QUERY_SURFACING_ACTIONS = [
		"slow_queries",
		"expensive_queries",
		"fatal_requests",
		"index_analysis",
		"query_execution",
	] as const;
	const DIAGNOSIS_TOOLS = ["capella_explain_sql_plus_plus_query", "capella_get_index_advisor_recommendations"] as const;

	for (const action of QUERY_SURFACING_ACTIONS) {
		test(`${action} carries the EXPLAIN + Index Advisor diagnosis tools`, () => {
			const agent = loadAgent(AGENTS_DIR);
			const couchbase = agent.tools.find((t) => t.name === "couchbase-cluster-health");
			expect(couchbase).toBeDefined();
			if (!couchbase) return;
			const map = couchbase.tool_mapping?.action_tool_map;
			expect(map).toBeDefined();
			if (!map) return;
			for (const tool of DIAGNOSIS_TOOLS) {
				expect(map[action]).toContain(tool);
			}
		});
	}

	test("full action-map union stays at 29 unique tools (no MAX_TOOLS_PER_AGENT pressure added)", () => {
		const agent = loadAgent(AGENTS_DIR);
		const couchbase = agent.tools.find((t) => t.name === "couchbase-cluster-health");
		expect(couchbase).toBeDefined();
		if (!couchbase) return;
		expect(getAllActionToolNames(couchbase).length).toBe(29);
	});
});

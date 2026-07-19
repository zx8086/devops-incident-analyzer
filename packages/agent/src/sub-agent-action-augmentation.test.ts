// agent/src/sub-agent-action-augmentation.test.ts

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
	getAllActionToolNames,
	loadAgent,
	matchActionsByKeywords,
	type ToolDefinition,
	ToolDefinitionSchema,
} from "@devops-agent/gitagent-bridge";
import type { StructuredToolInterface } from "@langchain/core/tools";
import {
	inferClusterHealthActions,
	mergeKeywordActions,
	narrowOnHighPrecisionIntent,
	selectToolsByAction,
} from "./sub-agent.ts";

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
			dlq_messages: ["kafka_consume_messages", "kafka_get_message_by_offset", "kafka_list_dlq_topics"],
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
			dlq_messages: ["dead letter", "dead-letter", "dlq"],
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
		"kafka_consume_messages",
		"kafka_get_message_by_offset",
		"kafka_list_dlq_topics",
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

	// SIO-785 follow-up (2026-05-18): when a DLQ keyword anchors the query,
	// strip the LLM's noise actions (describe_topic / topic_throughput) so
	// the LLM cannot wander to kafka_list_topics. The remote AgentCore-deployed
	// tool description points the LLM at "prefix=DLQ_" — and the only way to
	// neutralize that is to remove the competing actions upstream.
	test("narrowOnHighPrecisionIntent strips topic_throughput + describe_topic when dlq_messages anchors", () => {
		const merged = ["dlq_messages", "describe_topic", "topic_throughput", "health_check"];
		const keywordActions = ["dlq_messages"];
		const narrowed = narrowOnHighPrecisionIntent(merged, keywordActions);
		expect(narrowed.sort()).toEqual(["dlq_messages", "health_check"]);
	});

	test("narrowOnHighPrecisionIntent leaves merged unchanged when no high-precision trigger fires", () => {
		const merged = ["consumer_lag", "topic_throughput", "cluster_info"];
		const keywordActions = ["consumer_lag"]; // not in the narrowing rules
		const narrowed = narrowOnHighPrecisionIntent(merged, keywordActions);
		expect(narrowed).toEqual(merged);
	});

	test("narrowOnHighPrecisionIntent refuses to empty the action list", () => {
		// Edge case: if narrowing would leave NO actions, fall back to merged.
		const merged = ["describe_topic", "topic_throughput"]; // only the drop-targets
		const keywordActions = ["dlq_messages"]; // would drop both
		const narrowed = narrowOnHighPrecisionIntent(merged, keywordActions);
		// Since narrowing would empty the list, keep merged as-is.
		expect(narrowed).toEqual(merged);
	});

	// SIO-785 follow-up (2026-05-18): narrow single-action selection must NOT
	// fall through to the all-action fallback. The old MIN_FILTERED_TOOLS=5
	// floor crowded out kafka_list_dlq_topics for DLQ-specific queries — the
	// dlq_messages action resolves to 3 tools and was rejected as "too few",
	// so the fallback picked the first 25 across all actions, omitting the
	// DLQ tool. Live-verified on 2026-05-18 against c72-shared-services-msk.
	test("narrow single-action selection (dlq_messages, 3 tools) is honored, not fallen-through", () => {
		const query = "List the dead letter queue topics and their sizes";
		const baseActions: string[] = []; // LLM picked nothing
		const keywordActions = matchActionsByKeywords(query, kafkaToolDef);
		expect(keywordActions).toEqual(["dlq_messages"]);

		const merged = mergeKeywordActions(baseActions, keywordActions);
		const allTools = buildKafkaTools();
		const { tools, filtered } = selectToolsByAction(allTools, "kafka", { kafka: merged }, kafkaToolDef);

		expect(filtered).toBe(true);
		const names = tools.map((t) => t.name);
		// Must include kafka_list_dlq_topics so the extractor can populate
		// dlqTopics[] for KafkaFindingsCard's DLQ section.
		expect(names).toContain("kafka_list_dlq_topics");
		// Must NOT degenerate into a 25-tool kitchen-sink (that's the fallback).
		// dlq_messages alone has 3 tools.
		expect(names).toHaveLength(3);
		// And the 3 tools must be the dlq_messages ones, not random.
		expect(names.sort()).toEqual(["kafka_consume_messages", "kafka_get_message_by_offset", "kafka_list_dlq_topics"]);
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

// SIO-1137: a generic incident ("kong 504/503 on /orders") makes the extractor pick
// vitals/fatal/slow/expensive but NOT query_execution or index_analysis. The EXPLAIN +
// Index Advisor diagnosis tools must still land in the belt so statements that surface
// mid-investigation can be plan-checked and advised. Loads the REAL couchbase YAML so
// action-map drift cannot silently break the bundling.
describe("SIO-1137: couchbase query-diagnosis tools survive generic-incident action selection", () => {
	const AGENTS_DIR = join(import.meta.dir, "../../../agents/incident-analyzer");
	// Non-action-map capella tools that exist at runtime; padding pushes the total
	// past MAX_TOOLS_PER_AGENT (25) so the filter path engages, mirroring the live
	// couchbase MCP server (39 tools).
	const CAPELLA_EXTRA_TOOLS = [
		"capella_echo",
		"capella_get_playbook",
		"capella_list_playbooks",
		"capella_list_documentation",
		"capella_read_documentation",
		"capella_create_documentation",
		"capella_delete_documentation",
		"capella_sync_documentation_with_database",
		"capella_upsert_document_by_id",
		"capella_delete_document_by_id",
	];

	test("vitals+fatal+slow+expensive selection includes EXPLAIN and Index Advisor within the cap", () => {
		const agent = loadAgent(AGENTS_DIR);
		const couchbaseDef = agent.tools.find((t) => t.name === "couchbase-cluster-health");
		expect(couchbaseDef).toBeDefined();
		if (!couchbaseDef) return;
		const allTools = fakeTools([...getAllActionToolNames(couchbaseDef), ...CAPELLA_EXTRA_TOOLS]);
		expect(allTools.length).toBeGreaterThan(25);

		const actions = ["system_vitals", "fatal_requests", "slow_queries", "expensive_queries"];
		const { tools, filtered } = selectToolsByAction(allTools, "couchbase", { couchbase: actions }, couchbaseDef);

		expect(filtered).toBe(true);
		const names = tools.map((t) => t.name);
		expect(names).toContain("capella_explain_sql_plus_plus_query");
		expect(names).toContain("capella_get_index_advisor_recommendations");
		// SIO-1084 resolution tools must still be force-included alongside.
		expect(names).toContain("capella_get_scopes_and_collections");
		expect(tools.length).toBeLessThanOrEqual(25);
	});
});

// SIO-1161: the Metrics Insights + log-group-fields tools must survive the whole selection
// chain with the REAL aws-introspect.yaml -- keyword augmentation picks cloudwatch_metrics for
// fleet-triage phrasings, and the belt filter keeps the new tools under the 25-tool cap even
// on a realistic multi-action incident.
describe("SIO-1161: Metrics Insights tool selection with the real aws-introspect.yaml", () => {
	const AGENTS_DIR = join(import.meta.dir, "../../../agents/incident-analyzer");

	function loadAwsDef(): ToolDefinition {
		const agent = loadAgent(AGENTS_DIR);
		const awsDef = agent.tools.find((t) => t.name === "aws-introspect");
		if (!awsDef) throw new Error("aws-introspect tool definition not found");
		return awsDef;
	}

	test("fleet-triage phrasings keyword-match cloudwatch_metrics", () => {
		const awsDef = loadAwsDef();
		expect(matchActionsByKeywords("which service is noisiest right now", awsDef)).toContain("cloudwatch_metrics");
		expect(matchActionsByKeywords("show the top 10 lambda functions by errors", awsDef)).toContain(
			"cloudwatch_metrics",
		);
	});

	test("a neutral query does NOT keyword-match cloudwatch_metrics", () => {
		const awsDef = loadAwsDef();
		expect(matchActionsByKeywords("check the rds instance status", awsDef)).not.toContain("cloudwatch_metrics");
	});

	test("a realistic multi-action union keeps both new tools inside the 25-tool belt", () => {
		const awsDef = loadAwsDef();
		const allTools = fakeTools(getAllActionToolNames(awsDef));
		expect(allTools.length).toBeGreaterThan(25); // filter path must engage

		const actions = ["cloudwatch_metrics", "ec2_state", "logs_insights", "ecs_state"];
		const { tools, filtered } = selectToolsByAction(allTools, "aws", { aws: actions }, awsDef);

		expect(filtered).toBe(true);
		const names = tools.map((t) => t.name);
		expect(names).toContain("aws_cloudwatch_metrics_insights_query");
		expect(names).toContain("aws_logs_get_log_group_fields");
		// The async Logs Insights pair must never be split by the cap.
		expect(names).toContain("aws_logs_start_query");
		expect(names).toContain("aws_logs_get_query_results");
		expect(tools.length).toBeLessThanOrEqual(25);
	});
});

// agent/src/sub-agent-belt-ordering.test.ts
//
// SIO-1256: the tool belt must be a function of {allTools SET, actions, dataSourceId} -- never of
// allTools ORDER.
//
// The SIO-1161/SIO-1234 belt tests build allTools from getAllActionToolNames, i.e. YAML declaration
// order. Production builds it from getToolsForDataSource, i.e. MCP REGISTRATION order. On the live
// 4-group AWS union those two orders disagree by exactly one slot:
//
//   MCP order,  head 9  -> drops aws_ecs_list_tasks                      <- the live defect
//   YAML order, head 9  -> drops aws_ec2_describe_vpc_peering_connections <- why the test passed
//
// aws_ecs_list_tasks was declared in aws-introspect.yaml under ecs_state all along; it is registered
// LAST of the six ECS tools (packages/mcp-server-aws/src/tools/ecs/index.ts), so it landed at
// tail[16] of a 16-slot tail. Run cbada913-d22f-4618-826b-0c4c38fd8956 lost its ECS task count and
// security-group verification to that one slot, and every `Tool "aws_ecs_list_tasks" not found`
// error also produced a ToolMessage with no paired raw output -- the subagent.raw_output_count_mismatch
// warning in the same run.
//
// These tests assert the PROPERTY (order-independence), not a particular order, so no future fixture
// can hide the same bug.

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { getAllActionToolNames, loadAgent, type ToolDefinition } from "@devops-agent/gitagent-bridge";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { selectToolsByAction } from "./sub-agent.ts";

const REPO_ROOT = join(import.meta.dir, "../../..");
const AWS_MCP_TOOLS_DIR = join(REPO_ROOT, "packages/mcp-server-aws/src/tools");

function fakeTools(names: readonly string[]): StructuredToolInterface[] {
	return names.map((name) => ({ name }) as unknown as StructuredToolInterface);
}

function loadAwsDef(): ToolDefinition {
	const agent = loadAgent(join(REPO_ROOT, "agents/incident-analyzer"));
	const awsDef = agent.tools.find((t) => t.name === "aws-introspect");
	if (!awsDef) throw new Error("aws-introspect tool definition not found");
	return awsDef;
}

// The order packages/mcp-server-aws registers its tools in, which is the order they reach
// getToolsForDataSource and therefore the order composeBoundTools slices. NOT alphabetical and NOT
// YAML order -- source order. Pinned here rather than imported because @devops-agent/agent
// deliberately does not depend on @devops-agent/mcp-server-aws; the drift test below reads the real
// source to keep this honest.
const AWS_MCP_REGISTRATION_ORDER: readonly string[] = [
	"aws_list_estates",
	"aws_cloudformation_list_stacks",
	"aws_cloudformation_describe_stacks",
	"aws_cloudformation_describe_stack_events",
	"aws_cloudtrail_describe_trails",
	"aws_cloudtrail_get_trail_status",
	"aws_cloudtrail_list_trails",
	"aws_cloudwatch_get_metric_data",
	"aws_cloudwatch_metrics_insights_query",
	"aws_cloudwatch_describe_alarms",
	"aws_config_describe_config_rules",
	"aws_config_list_discovered_resources",
	"aws_config_get_discovered_resource_counts",
	"aws_dynamodb_list_tables",
	"aws_dynamodb_describe_table",
	"aws_ec2_describe_vpcs",
	"aws_ec2_describe_instances",
	"aws_ec2_describe_security_groups",
	"aws_ec2_describe_subnets",
	"aws_ec2_describe_vpc_endpoints",
	"aws_ec2_describe_network_interfaces",
	"aws_ec2_describe_route_tables",
	"aws_ec2_describe_nat_gateways",
	"aws_ec2_describe_network_acls",
	"aws_ec2_describe_flow_logs",
	"aws_ec2_describe_transit_gateways",
	"aws_ec2_describe_vpc_peering_connections",
	"aws_ecs_list_clusters",
	"aws_ecs_list_services",
	"aws_ecs_describe_services",
	"aws_ecs_describe_tasks",
	"aws_ecs_describe_task_definition",
	// Registered LAST of the six. This single fact is the whole defect.
	"aws_ecs_list_tasks",
	"aws_elasticache_describe_cache_clusters",
	"aws_elasticache_describe_replication_groups",
	"aws_elbv2_describe_load_balancers",
	"aws_elbv2_describe_listeners",
	"aws_elbv2_describe_target_groups",
	"aws_elbv2_describe_target_health",
	"aws_guardduty_list_detectors",
	"aws_guardduty_get_detector",
	"aws_guardduty_list_findings",
	"aws_guardduty_get_findings",
	"aws_health_describe_events",
	"aws_lambda_list_functions",
	"aws_lambda_get_function_configuration",
	"aws_logs_describe_log_groups",
	"aws_logs_start_query",
	"aws_logs_get_query_results",
	"aws_logs_get_log_group_fields",
	"aws_sns_list_topics",
	"aws_sns_get_topic_attributes",
	"aws_sqs_list_queues",
	"aws_sqs_get_queue_attributes",
	"aws_eventbridge_list_rules",
	"aws_eventbridge_describe_rule",
	"aws_stepfunctions_list_state_machines",
	"aws_rds_describe_db_instances",
	"aws_rds_describe_db_clusters",
	"aws_route53_list_hosted_zones",
	"aws_route53_list_resource_record_sets",
	"aws_s3_list_buckets",
	"aws_s3_get_bucket_location",
	"aws_s3_get_bucket_policy_status",
	"aws_securityhub_get_findings",
	"aws_securityhub_describe_hub",
	"aws_securityhub_get_enabled_standards",
	"aws_resourcegroupstagging_get_resources",
	"aws_xray_get_service_graph",
	"aws_xray_get_trace_summaries",
];

// The union observed in run cbada913-d22f-4618-826b-0c4c38fd8956: cloudwatch_metrics(2) +
// ec2_state(12) + logs_insights(4) + ecs_state(6) = 24 distinct, which dedups against the 9-tool
// head to a 17-entry tail for 16 slots. Exactly one tool falls off, and WHICH one is decided
// purely by the ordering of allTools -- that is the defect.
const LIVE_UNION_ACTIONS = ["cloudwatch_metrics", "ec2_state", "logs_insights", "ecs_state"];

// aws-agent/RULES.md mandates these. :198 (historical task lookup), :205 (SIO-1208 placement
// baseline), :206 (the ECS chain). aws_ecs_describe_tasks is NOT a substitute for
// aws_ecs_list_tasks: it only accepts KNOWN task ARNs and cannot search by time, service or IP --
// RULES.md:198 says so verbatim, which is why the two are bound as a pair.
const AWS_MANDATED_BY_RULES: readonly string[] = [
	"aws_ecs_list_clusters",
	"aws_ecs_list_services",
	"aws_ecs_describe_services",
	"aws_ecs_list_tasks",
	"aws_ecs_describe_tasks",
	"aws_logs_describe_log_groups",
	"aws_logs_get_log_group_fields",
	"aws_logs_start_query",
	"aws_logs_get_query_results",
];

// Deterministic LCG shuffle. Math.random() would make a failure unreproducible, and this test
// exists precisely to catch an ordering bug -- a flaky ordering test is worse than none.
function seededShuffle<T>(items: readonly T[], seed: number): T[] {
	const out = [...items];
	let s = seed >>> 0;
	for (let i = out.length - 1; i > 0; i--) {
		s = (s * 1664525 + 1013904223) >>> 0;
		const j = s % (i + 1);
		const a = out[i] as T;
		const b = out[j] as T;
		out[i] = b;
		out[j] = a;
	}
	return out;
}

function boundNames(universe: readonly string[], actions: string[], awsDef: ToolDefinition): Set<string> {
	const { tools } = selectToolsByAction(fakeTools(universe), "aws", { aws: actions }, awsDef);
	return new Set(tools.map((t) => t.name));
}

describe("SIO-1256: the AWS registration-order fixture matches the real MCP server", () => {
	// Reads the real source rather than importing it -- @devops-agent/agent must not take a
	// workspace dependency on @devops-agent/mcp-server-aws just to test this. Same technique as
	// sub-agent-kafka-yaml-drift.test.ts.
	async function readRegistrationOrder(): Promise<string[]> {
		const registerSrc = await Bun.file(join(AWS_MCP_TOOLS_DIR, "register.ts")).text();
		const body = registerSrc.split("export function registerAllTools")[1];
		if (!body) throw new Error("registerAllTools not found in register.ts");

		const imports = new Map<string, string>();
		for (const m of registerSrc.matchAll(/import \{ register(\w+?)(?:Tools|Tool) \} from "\.\/([^"]+)"/g)) {
			const [, key, path] = m;
			if (key && path) imports.set(key, path);
		}

		const names: string[] = [];
		for (const m of body.matchAll(/\bregister(\w+?)(?:Tools|Tool)\(server/g)) {
			const key = m[1];
			if (!key) continue;
			const path = imports.get(key);
			if (!path) throw new Error(`no import found for register${key}`);
			const src = await Bun.file(join(AWS_MCP_TOOLS_DIR, path)).text();
			for (const t of src.matchAll(/server\.tool\(\s*"(aws_[a-z0-9_]+)"/g)) {
				const name = t[1];
				if (name) names.push(name);
			}
		}
		return names;
	}

	test("the pinned fixture is byte-identical to the source registration order", async () => {
		expect(await readRegistrationOrder()).toEqual([...AWS_MCP_REGISTRATION_ORDER]);
	});

	test("aws_ecs_list_tasks is registered last of the ECS tools", async () => {
		const order = await readRegistrationOrder();
		const ecs = order.filter((n) => n.startsWith("aws_ecs_"));
		expect(ecs.at(-1)).toBe("aws_ecs_list_tasks");
	});
});

describe("SIO-1256: the bound belt does not depend on allTools ordering", () => {
	test("every permutation of allTools binds the same set", () => {
		const awsDef = loadAwsDef();
		const baseline = boundNames(AWS_MCP_REGISTRATION_ORDER, LIVE_UNION_ACTIONS, awsDef);

		for (let seed = 1; seed <= 50; seed++) {
			const permuted = boundNames(seededShuffle(AWS_MCP_REGISTRATION_ORDER, seed), LIVE_UNION_ACTIONS, awsDef);
			expect(permuted.size).toBeLessThanOrEqual(25);
			// Set equality, not array equality: the ORDER of the bound list is allowed to vary,
			// only its membership must not.
			expect([...permuted].sort()).toEqual([...baseline].sort());
		}
	});

	// The specific divergence that hid the defect: the two orders any test in this repo might
	// plausibly pick must agree.
	test("MCP registration order and YAML declaration order bind the same set", () => {
		const awsDef = loadAwsDef();
		const mcp = boundNames(AWS_MCP_REGISTRATION_ORDER, LIVE_UNION_ACTIONS, awsDef);
		const yaml = boundNames(getAllActionToolNames(awsDef), LIVE_UNION_ACTIONS, awsDef);
		expect([...mcp].sort()).toEqual([...yaml].sort());
	});
});

// AWS is only where the cap binds hardest -- every belt test in this package builds allTools from
// YAML order or a hand-written list, so the fixture-vs-production divergence is systemic. Pin the
// property for the other action-mapped datasources too, so the next one to outgrow the cap does not
// have to rediscover this.
describe("SIO-1256: belt ordering is irrelevant for every action-mapped datasource", () => {
	const DATASOURCES: Array<{ dataSourceId: string; toolName: string }> = [
		{ dataSourceId: "gitlab", toolName: "gitlab-api" },
		{ dataSourceId: "kafka", toolName: "kafka-introspect" },
		{ dataSourceId: "couchbase", toolName: "couchbase-cluster-health" },
	];

	for (const { dataSourceId, toolName } of DATASOURCES) {
		test(`${dataSourceId}: the bound set survives a shuffled allTools`, () => {
			const agent = loadAgent(join(REPO_ROOT, "agents/incident-analyzer"));
			const toolDef = agent.tools.find((t) => t.name === toolName);
			expect(toolDef).toBeDefined();
			if (!toolDef) return;

			const universe = getAllActionToolNames(toolDef);
			const actions = Object.keys(toolDef.tool_mapping?.action_tool_map ?? {});
			expect(actions.length).toBeGreaterThan(0);

			const baseline = selectToolsByAction(fakeTools(universe), dataSourceId, { [dataSourceId]: actions }, toolDef);
			const baselineNames = [...new Set(baseline.tools.map((t) => t.name))].sort();

			for (let seed = 1; seed <= 20; seed++) {
				const permuted = selectToolsByAction(
					fakeTools(seededShuffle(universe, seed)),
					dataSourceId,
					{ [dataSourceId]: actions },
					toolDef,
				);
				expect([...new Set(permuted.tools.map((t) => t.name))].sort()).toEqual(baselineNames);
			}
		});
	}
});

describe("SIO-1256: RULES-mandated AWS tools survive the cap under any ordering", () => {
	const orderings: Array<[string, () => readonly string[]]> = [
		["MCP registration order", () => AWS_MCP_REGISTRATION_ORDER],
		["reversed", () => [...AWS_MCP_REGISTRATION_ORDER].reverse()],
		["YAML declaration order", () => getAllActionToolNames(loadAwsDef())],
	];

	for (const [label, universe] of orderings) {
		test(`the live 4-group union binds every RULES-mandated tool (${label})`, () => {
			const awsDef = loadAwsDef();
			const names = boundNames(universe(), LIVE_UNION_ACTIONS, awsDef);
			expect(names.size).toBeLessThanOrEqual(25);
			for (const mandated of AWS_MANDATED_BY_RULES) {
				expect(names.has(mandated)).toBe(true);
			}
		});
	}

	// The exact live regression, stated as its own test so a failure names the defect directly
	// rather than pointing at a loop iteration.
	test("aws_ecs_list_tasks is bound in MCP registration order (the live defect)", () => {
		const awsDef = loadAwsDef();
		expect(boundNames(AWS_MCP_REGISTRATION_ORDER, LIVE_UNION_ACTIONS, awsDef).has("aws_ecs_list_tasks")).toBe(true);
	});
});

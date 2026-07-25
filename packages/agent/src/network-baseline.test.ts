// agent/src/network-baseline.test.ts
import { describe, expect, test } from "bun:test";
import type { ToolOutput } from "@devops-agent/shared";
import { fetchNetworkBaseline, isNetworkBaselineEnabled, networkBaselineTimeoutMs } from "./network-baseline.ts";

const ALL_TOOLS = new Set([
	"aws_ecs_list_clusters",
	"aws_ecs_list_services",
	"aws_ecs_list_tasks",
	"aws_ecs_describe_tasks",
	"aws_ec2_describe_subnets",
	"aws_ec2_describe_vpcs",
]);

const TASKS_JSON = {
	tasks: [
		{
			attachments: [
				{
					details: [
						{ name: "subnetId", value: "subnet-1" },
						{ name: "privateIPv4Address", value: "10.35.12.166" },
					],
				},
			],
		},
	],
};
const SUBNETS_JSON = { Subnets: [{ SubnetId: "subnet-1", VpcId: "vpc-1", CidrBlock: "10.35.12.0/24" }] };

interface Call {
	toolName: string;
	args: Record<string, unknown>;
}

function makeInvoke(responses: Record<string, unknown>, calls: Call[]) {
	return async (toolName: string, args: Record<string, unknown>) => {
		calls.push({ toolName, args });
		if (!(toolName in responses)) throw new Error(`unexpected call: ${toolName}`);
		const value = responses[toolName];
		if (value instanceof Error) throw value;
		return value;
	};
}

describe("gates", () => {
	test("isNetworkBaselineEnabled defaults ON, off for false/0", () => {
		expect(isNetworkBaselineEnabled({} as NodeJS.ProcessEnv)).toBe(true);
		expect(isNetworkBaselineEnabled({ NETWORK_BASELINE_ENABLED: "false" } as NodeJS.ProcessEnv)).toBe(false);
		expect(isNetworkBaselineEnabled({ NETWORK_BASELINE_ENABLED: "0" } as NodeJS.ProcessEnv)).toBe(false);
	});

	test("timeout parses positive integers and falls back on junk", () => {
		expect(networkBaselineTimeoutMs({ NETWORK_BASELINE_TIMEOUT_MS: "2500" } as NodeJS.ProcessEnv)).toBe(2500);
		expect(networkBaselineTimeoutMs({ NETWORK_BASELINE_TIMEOUT_MS: "nope" } as NodeJS.ProcessEnv)).toBe(8000);
	});
});

describe("fetchNetworkBaseline", () => {
	test("derives targets from the loop's describe_services output and fetches the placement chain", async () => {
		const existing: ToolOutput[] = [
			{
				toolName: "aws_ecs_describe_services",
				rawJson: {
					services: [
						{ serviceName: "order-service", clusterArn: "arn:aws:ecs:eu-west-1:1:cluster/eu-oit-prd" },
						{ serviceName: "unrelated-billing", clusterArn: "arn:aws:ecs:eu-west-1:1:cluster/eu-oit-prd" },
					],
				},
			},
		];
		const calls: Call[] = [];
		const out = await fetchNetworkBaseline({
			invoke: makeInvoke(
				{
					aws_ecs_list_tasks: { taskArns: ["arn:aws:ecs:eu-west-1:1:task/eu-oit-prd/abc"] },
					aws_ecs_describe_tasks: TASKS_JSON,
					aws_ec2_describe_subnets: SUBNETS_JSON,
					aws_ec2_describe_vpcs: { Vpcs: [{ VpcId: "vpc-1", CidrBlock: "10.35.0.0/16" }] },
				},
				calls,
			),
			hasTool: (n) => ALL_TOOLS.has(n),
			existingOutputs: existing,
			focusServices: ["prana-order-service"],
		});
		// focus-matched to order-service only; the discovery probe (list_tasks) is
		// invoked but NOT recorded; the three map-feeding outputs are recorded.
		expect(calls.map((c) => c.toolName)).toEqual([
			"aws_ecs_list_tasks",
			"aws_ecs_describe_tasks",
			"aws_ec2_describe_subnets",
			"aws_ec2_describe_vpcs",
		]);
		expect(calls[0]?.args).toMatchObject({
			cluster: "eu-oit-prd",
			serviceName: "order-service",
			desiredStatus: "RUNNING",
		});
		expect(calls[2]?.args).toEqual({ subnetIds: ["subnet-1"] });
		expect(calls[3]?.args).toEqual({ vpcIds: ["vpc-1"] });
		expect(out.map((o) => o.toolName)).toEqual([
			"aws_ecs_describe_tasks",
			"aws_ec2_describe_subnets",
			"aws_ec2_describe_vpcs",
		]);
	});

	test("reuses the loop's describe_tasks output and only fills the subnet/vpc gap", async () => {
		const existing: ToolOutput[] = [{ toolName: "aws_ecs_describe_tasks", rawJson: TASKS_JSON }];
		const calls: Call[] = [];
		const out = await fetchNetworkBaseline({
			invoke: makeInvoke(
				{
					aws_ec2_describe_subnets: SUBNETS_JSON,
					aws_ec2_describe_vpcs: { Vpcs: [] },
				},
				calls,
			),
			hasTool: (n) => ALL_TOOLS.has(n),
			existingOutputs: existing,
			focusServices: ["order-service"],
		});
		expect(calls.map((c) => c.toolName)).toEqual(["aws_ec2_describe_subnets", "aws_ec2_describe_vpcs"]);
		expect(out.map((o) => o.toolName)).toEqual(["aws_ec2_describe_subnets", "aws_ec2_describe_vpcs"]);
	});

	test("enumeration fallback discovers services when the loop never touched ECS", async () => {
		const calls: Call[] = [];
		const out = await fetchNetworkBaseline({
			invoke: makeInvoke(
				{
					aws_ecs_list_clusters: { clusterArns: ["arn:aws:ecs:eu-west-1:1:cluster/eu-oit-prd"] },
					aws_ecs_list_services: { serviceArns: ["arn:aws:ecs:eu-west-1:1:service/eu-oit-prd/order-service"] },
					aws_ecs_list_tasks: { taskArns: ["arn:aws:ecs:eu-west-1:1:task/eu-oit-prd/abc"] },
					aws_ecs_describe_tasks: TASKS_JSON,
					aws_ec2_describe_subnets: SUBNETS_JSON,
					aws_ec2_describe_vpcs: { Vpcs: [] },
				},
				calls,
			),
			hasTool: (n) => ALL_TOOLS.has(n),
			existingOutputs: [],
			focusServices: ["order-service"],
		});
		expect(calls[0]?.toolName).toBe("aws_ecs_list_clusters");
		expect(calls[1]?.toolName).toBe("aws_ecs_list_services");
		// discovery probes are never persisted onto toolOutputs.
		expect(out.map((o) => o.toolName)).toEqual([
			"aws_ecs_describe_tasks",
			"aws_ec2_describe_subnets",
			"aws_ec2_describe_vpcs",
		]);
	});

	test("small-estate fallback takes candidates when focus matches nothing", async () => {
		const existing: ToolOutput[] = [
			{
				toolName: "aws_ecs_list_services",
				rawJson: { serviceArns: ["arn:aws:ecs:eu-west-1:1:service/shared/images-service"] },
			},
		];
		const calls: Call[] = [];
		await fetchNetworkBaseline({
			invoke: makeInvoke(
				{
					aws_ecs_list_tasks: { taskArns: [] },
				},
				calls,
			),
			hasTool: (n) => ALL_TOOLS.has(n),
			existingOutputs: existing,
			focusServices: ["totally-different-name"],
		});
		expect(calls.map((c) => c.toolName)).toEqual(["aws_ecs_list_tasks"]);
		expect(calls[0]?.args).toMatchObject({ cluster: "shared", serviceName: "images-service" });
	});

	test("gap-fill is coverage-based: unrelated existing subnet output does not suppress the fetch", async () => {
		const existing: ToolOutput[] = [
			{ toolName: "aws_ecs_describe_tasks", rawJson: TASKS_JSON },
			// The ingress protocol fetched OTHER subnets; ours (subnet-1) is not covered.
			{
				toolName: "aws_ec2_describe_subnets",
				rawJson: { Subnets: [{ SubnetId: "subnet-other", VpcId: "vpc-9" }] },
			},
		];
		const calls: Call[] = [];
		await fetchNetworkBaseline({
			invoke: makeInvoke({ aws_ec2_describe_subnets: SUBNETS_JSON, aws_ec2_describe_vpcs: { Vpcs: [] } }, calls),
			hasTool: (n) => ALL_TOOLS.has(n),
			existingOutputs: existing,
			focusServices: ["order-service"],
		});
		expect(calls[0]?.args).toEqual({ subnetIds: ["subnet-1"] });
	});

	test("fully-covered subnets skip the fetch but still resolve their VPCs", async () => {
		const existing: ToolOutput[] = [
			{ toolName: "aws_ecs_describe_tasks", rawJson: TASKS_JSON },
			{ toolName: "aws_ec2_describe_subnets", rawJson: SUBNETS_JSON },
		];
		const calls: Call[] = [];
		await fetchNetworkBaseline({
			invoke: makeInvoke({ aws_ec2_describe_vpcs: { Vpcs: [] } }, calls),
			hasTool: (n) => ALL_TOOLS.has(n),
			existingOutputs: existing,
			focusServices: ["order-service"],
		});
		expect(calls.map((c) => c.toolName)).toEqual(["aws_ec2_describe_vpcs"]);
		expect(calls[0]?.args).toEqual({ vpcIds: ["vpc-1"] });
	});

	test("missing core tools -> no calls, empty result", async () => {
		const calls: Call[] = [];
		const out = await fetchNetworkBaseline({
			invoke: makeInvoke({}, calls),
			hasTool: (n) => n !== "aws_ec2_describe_subnets" && ALL_TOOLS.has(n),
			existingOutputs: [],
			focusServices: ["order-service"],
		});
		expect(out).toEqual([]);
		expect(calls).toEqual([]);
	});

	test("a failing step soft-skips without dropping earlier outputs", async () => {
		const existing: ToolOutput[] = [{ toolName: "aws_ecs_describe_tasks", rawJson: TASKS_JSON }];
		const calls: Call[] = [];
		const out = await fetchNetworkBaseline({
			invoke: makeInvoke({ aws_ec2_describe_subnets: new Error("throttled") }, calls),
			hasTool: (n) => ALL_TOOLS.has(n),
			existingOutputs: existing,
			focusServices: ["order-service"],
		});
		expect(out).toEqual([]);
		expect(calls.map((c) => c.toolName)).toEqual(["aws_ec2_describe_subnets"]);
	});

	test("an exhausted deadline starts no calls", async () => {
		const calls: Call[] = [];
		const out = await fetchNetworkBaseline({
			invoke: makeInvoke({}, calls),
			hasTool: (n) => ALL_TOOLS.has(n),
			existingOutputs: [],
			focusServices: ["order-service"],
			timeoutMs: -1,
		});
		expect(out).toEqual([]);
		expect(calls).toEqual([]);
	});
});

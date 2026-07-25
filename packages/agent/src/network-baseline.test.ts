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
	"aws_ec2_describe_instances",
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
		const { outputs, diagnostics } = await fetchNetworkBaseline({
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
		expect(outputs.map((o) => o.toolName)).toEqual([
			"aws_ecs_describe_tasks",
			"aws_ec2_describe_subnets",
			"aws_ec2_describe_vpcs",
		]);
		expect(diagnostics.candidatesFound).toBe(2);
		expect(diagnostics.candidatesMatched).toBe(1);
		expect(diagnostics.skippedReason).toBeUndefined();
	});

	test("reuses the loop's describe_tasks output and only fills the subnet/vpc gap", async () => {
		const existing: ToolOutput[] = [{ toolName: "aws_ecs_describe_tasks", rawJson: TASKS_JSON }];
		const calls: Call[] = [];
		const { outputs } = await fetchNetworkBaseline({
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
		expect(outputs.map((o) => o.toolName)).toEqual(["aws_ec2_describe_subnets", "aws_ec2_describe_vpcs"]);
	});

	test("enumeration fallback discovers services when the loop never touched ECS", async () => {
		const calls: Call[] = [];
		const { outputs, diagnostics } = await fetchNetworkBaseline({
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
		expect(outputs.map((o) => o.toolName)).toEqual([
			"aws_ecs_describe_tasks",
			"aws_ec2_describe_subnets",
			"aws_ec2_describe_vpcs",
		]);
		expect(diagnostics.fallbackUsed).toBeUndefined();
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

	test("missing core tools -> no calls, empty result, skippedReason no-ecs-tools", async () => {
		const calls: Call[] = [];
		const { outputs, diagnostics } = await fetchNetworkBaseline({
			invoke: makeInvoke({}, calls),
			hasTool: (n) => n !== "aws_ec2_describe_subnets" && ALL_TOOLS.has(n),
			existingOutputs: [],
			focusServices: ["order-service"],
		});
		expect(outputs).toEqual([]);
		expect(calls).toEqual([]);
		expect(diagnostics.skippedReason).toBe("no-ecs-tools");
	});

	test("a failing step soft-skips without dropping earlier outputs", async () => {
		const existing: ToolOutput[] = [{ toolName: "aws_ecs_describe_tasks", rawJson: TASKS_JSON }];
		const calls: Call[] = [];
		const { outputs } = await fetchNetworkBaseline({
			invoke: makeInvoke({ aws_ec2_describe_subnets: new Error("throttled") }, calls),
			hasTool: (n) => ALL_TOOLS.has(n),
			existingOutputs: existing,
			focusServices: ["order-service"],
		});
		expect(outputs).toEqual([]);
		expect(calls.map((c) => c.toolName)).toEqual(["aws_ec2_describe_subnets"]);
	});

	test("an exhausted deadline starts no calls", async () => {
		const calls: Call[] = [];
		const { outputs } = await fetchNetworkBaseline({
			invoke: makeInvoke({}, calls),
			hasTool: (n) => ALL_TOOLS.has(n),
			existingOutputs: [],
			focusServices: ["order-service"],
			timeoutMs: -1,
		});
		expect(outputs).toEqual([]);
		expect(calls).toEqual([]);
	});

	// SIO-1210: EKS estates have no ECS clusters, so list_clusters legitimately
	// returns []. The EC2-instance fallback is the only remaining placement signal.
	describe("EKS / EC2-instance fallback", () => {
		const INSTANCES_JSON = {
			Reservations: [
				{
					Instances: [
						{ InstanceId: "i-abc123", SubnetId: "subnet-1", Tags: [{ Key: "Name", Value: "notification-service" }] },
						{ InstanceId: "i-def456", SubnetId: "subnet-2", Tags: [{ Key: "Name", Value: "unrelated-billing" }] },
					],
				},
			],
		};

		test("falls back to EC2 instances when list_clusters is empty and finds a focus match", async () => {
			const calls: Call[] = [];
			const { outputs, diagnostics } = await fetchNetworkBaseline({
				invoke: makeInvoke(
					{
						aws_ecs_list_clusters: { clusterArns: [] },
						aws_ec2_describe_instances: INSTANCES_JSON,
						aws_ec2_describe_subnets: { Subnets: [{ SubnetId: "subnet-1", VpcId: "vpc-1" }] },
						aws_ec2_describe_vpcs: { Vpcs: [] },
					},
					calls,
				),
				hasTool: (n) => ALL_TOOLS.has(n),
				existingOutputs: [],
				focusServices: ["NotificationService"],
			});
			expect(calls.map((c) => c.toolName)).toEqual([
				"aws_ecs_list_clusters",
				"aws_ec2_describe_instances",
				"aws_ec2_describe_instances",
				"aws_ec2_describe_subnets",
				"aws_ec2_describe_vpcs",
			]);
			// second describe_instances call is the recorded, focus-matched one
			expect(calls[2]?.args).toEqual({ instanceIds: ["i-abc123"] });
			expect(outputs.map((o) => o.toolName)).toContain("aws_ec2_describe_instances");
			expect(diagnostics.fallbackUsed).toBe("ec2-instances");
			expect(diagnostics.candidatesMatched).toBe(1);
		});

		test("EC2 fallback subnet ids feed the existing subnet/vpc gap-fill", async () => {
			const calls: Call[] = [];
			// Filtered describe_instances call (post-focus-match) only returns the
			// matched instance, same as the real AWS API would with instanceIds set.
			const FILTERED_INSTANCES_JSON = {
				Reservations: [
					{
						Instances: [
							{ InstanceId: "i-abc123", SubnetId: "subnet-1", Tags: [{ Key: "Name", Value: "notification-service" }] },
						],
					},
				],
			};
			let describeInstancesCallCount = 0;
			await fetchNetworkBaseline({
				invoke: makeInvoke(
					{
						aws_ecs_list_clusters: { clusterArns: [] },
						get aws_ec2_describe_instances() {
							describeInstancesCallCount += 1;
							return describeInstancesCallCount === 1 ? INSTANCES_JSON : FILTERED_INSTANCES_JSON;
						},
						aws_ec2_describe_subnets: { Subnets: [{ SubnetId: "subnet-1", VpcId: "vpc-1" }] },
						aws_ec2_describe_vpcs: { Vpcs: [{ VpcId: "vpc-1" }] },
					},
					calls,
				),
				hasTool: (n) => ALL_TOOLS.has(n),
				existingOutputs: [],
				focusServices: ["NotificationService"],
			});
			const subnetsCall = calls.find((c) => c.toolName === "aws_ec2_describe_subnets");
			expect(subnetsCall?.args).toEqual({ subnetIds: ["subnet-1"] });
			const vpcsCall = calls.find((c) => c.toolName === "aws_ec2_describe_vpcs");
			expect(vpcsCall?.args).toEqual({ vpcIds: ["vpc-1"] });
		});

		test("no aws_ec2_describe_instances tool -> no fallback attempted, skippedReason no-clusters", async () => {
			const calls: Call[] = [];
			const { outputs, diagnostics } = await fetchNetworkBaseline({
				invoke: makeInvoke({ aws_ecs_list_clusters: { clusterArns: [] } }, calls),
				hasTool: (n) => n !== "aws_ec2_describe_instances" && ALL_TOOLS.has(n),
				existingOutputs: [],
				focusServices: ["NotificationService"],
			});
			expect(calls.map((c) => c.toolName)).toEqual(["aws_ecs_list_clusters"]);
			expect(outputs).toEqual([]);
			expect(diagnostics.skippedReason).toBe("no-clusters");
			expect(diagnostics.fallbackUsed).toBeUndefined();
		});

		test("EC2 instances found but none focus-match -> skippedReason no-focus-match", async () => {
			const calls: Call[] = [];
			const { outputs, diagnostics } = await fetchNetworkBaseline({
				invoke: makeInvoke(
					{
						aws_ecs_list_clusters: { clusterArns: [] },
						aws_ec2_describe_instances: {
							Reservations: [
								{
									Instances: Array.from({ length: 6 }, (_, i) => ({
										InstanceId: `i-${i}`,
										SubnetId: "subnet-1",
										Tags: [{ Key: "Name", Value: `unrelated-service-${i}` }],
									})),
								},
							],
						},
					},
					calls,
				),
				hasTool: (n) => ALL_TOOLS.has(n),
				existingOutputs: [],
				focusServices: ["NotificationService"],
			});
			// 6 candidates exceeds SMALL_ESTATE_CANDIDATE_CAP (5), none focus-matched.
			expect(outputs).toEqual([]);
			expect(diagnostics.candidatesFound).toBe(6);
			expect(diagnostics.candidatesMatched).toBe(0);
			expect(diagnostics.skippedReason).toBe("no-focus-match");
		});
	});
});

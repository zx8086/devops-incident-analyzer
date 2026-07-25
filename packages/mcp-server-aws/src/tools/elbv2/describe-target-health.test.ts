// src/tools/elbv2/describe-target-health.test.ts
import { afterEach, describe, expect, test } from "bun:test";
import { DescribeTargetHealthCommand, ElasticLoadBalancingV2Client } from "@aws-sdk/client-elastic-load-balancing-v2";
import { mockClient } from "aws-sdk-client-mock";
import type { AwsConfig } from "../../config/schemas.ts";
import { _resetClientsForTests } from "../../services/client-factory.ts";
import { describeTargetHealth, describeTargetHealthSchema, summarizeTargetHealth } from "./describe-target-health.ts";

const config: AwsConfig = {
	region: "eu-central-1",
	estates: {
		prod: {
			assumedRoleArn: "arn:aws:iam::356994971776:role/DevOpsAgentReadOnly",
			externalId: "aws-mcp-readonly-2026",
		},
	},
};

const TG_ARN = "arn:aws:elasticloadbalancing:eu-central-1:1:targetgroup/web/abc";

afterEach(() => _resetClientsForTests());

describe("describeTargetHealthSchema", () => {
	test("requires targetGroupArn", () => {
		expect(describeTargetHealthSchema.safeParse({}).success).toBe(false);
		expect(describeTargetHealthSchema.safeParse({ targetGroupArn: TG_ARN }).success).toBe(true);
	});

	test("accepts optional targets with Id and Port", () => {
		expect(
			describeTargetHealthSchema.safeParse({ targetGroupArn: TG_ARN, targets: [{ Id: "10.0.1.5", Port: 8080 }] })
				.success,
		).toBe(true);
	});

	test("rejects a target missing Id", () => {
		expect(describeTargetHealthSchema.safeParse({ targetGroupArn: TG_ARN, targets: [{ Port: 8080 }] }).success).toBe(
			false,
		);
	});

	// SIO-1205: the API has NO pagination, so the schema must not declare limit/cursor.
	// Zod strips unknown keys, so parsing succeeds but the aliases must NOT survive.
	test("has no limit/cursor pagination aliases (unknown keys are stripped)", () => {
		const parsed = describeTargetHealthSchema.parse({ targetGroupArn: TG_ARN, limit: 10, cursor: "tok" });
		expect("limit" in parsed).toBe(false);
		expect("cursor" in parsed).toBe(false);
	});
});

describe("describeTargetHealth handler", () => {
	test("returns TargetHealthDescriptions[] and echoes the requested TargetGroupArn", async () => {
		const elbMock = mockClient(ElasticLoadBalancingV2Client);
		elbMock.on(DescribeTargetHealthCommand).resolves({
			TargetHealthDescriptions: [
				{ Target: { Id: "10.0.1.5", Port: 8080 }, TargetHealth: { State: "healthy" } },
				{
					Target: { Id: "i-abc", Port: 8080 },
					TargetHealth: { State: "unhealthy", Reason: "Target.FailedHealthChecks" },
				},
			],
		});

		const handler = describeTargetHealth(config);
		const result = (await handler({ estate: "prod", targetGroupArn: TG_ARN })) as {
			TargetGroupArn: string;
			TargetHealthDescriptions: { TargetHealth: { State: string } }[];
		};
		// SIO-1205: the SDK response carries no target group ARN; the handler must echo the
		// requested ARN so the network-map builder can attribute health rows to a target group.
		expect(result.TargetGroupArn).toBe(TG_ARN);
		expect(result.TargetHealthDescriptions).toHaveLength(2);
		expect(result.TargetHealthDescriptions[1]?.TargetHealth.State).toBe("unhealthy");
	});

	test("forwards specific targets to the SDK command", async () => {
		const elbMock = mockClient(ElasticLoadBalancingV2Client);
		elbMock.on(DescribeTargetHealthCommand).resolves({ TargetHealthDescriptions: [] });

		const handler = describeTargetHealth(config);
		await handler({ estate: "prod", targetGroupArn: TG_ARN, targets: [{ Id: "10.0.1.5", Port: 8080 }] });
		const call = elbMock.commandCalls(DescribeTargetHealthCommand)[0];
		expect(call?.args[0].input.TargetGroupArn).toBe(TG_ARN);
		expect(call?.args[0].input.Targets).toEqual([{ Id: "10.0.1.5", Port: 8080 }]);
	});
});

describe("summarizeTargetHealth", () => {
	test("projects Target.Id, Target.Port, TargetHealth.State", () => {
		const summary = summarizeTargetHealth({
			TargetHealthDescriptions: [
				{
					Target: { Id: "10.0.1.5", Port: 8080, AvailabilityZone: "eu-central-1a" },
					HealthCheckPort: "8080",
					TargetHealth: { State: "healthy", Description: "ok" },
				},
			],
		});
		expect(summary).toEqual([{ Id: "10.0.1.5", Port: 8080, State: "healthy" }]);
	});

	test("missing TargetHealthDescriptions -> empty array", () => {
		expect(summarizeTargetHealth({})).toEqual([]);
	});
});

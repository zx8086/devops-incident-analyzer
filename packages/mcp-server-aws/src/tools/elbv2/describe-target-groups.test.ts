// src/tools/elbv2/describe-target-groups.test.ts
import { afterEach, describe, expect, test } from "bun:test";
import { DescribeTargetGroupsCommand, ElasticLoadBalancingV2Client } from "@aws-sdk/client-elastic-load-balancing-v2";
import { mockClient } from "aws-sdk-client-mock";
import type { AwsConfig } from "../../config/schemas.ts";
import { _resetClientsForTests } from "../../services/client-factory.ts";
import type { ToolError } from "../types.ts";
import { describeTargetGroups, describeTargetGroupsSchema } from "./describe-target-groups.ts";

const config: AwsConfig = {
	region: "eu-central-1",
	estates: {
		prod: {
			assumedRoleArn: "arn:aws:iam::356994971776:role/DevOpsAgentReadOnly",
			externalId: "aws-mcp-readonly-2026",
		},
	},
};

const LB_ARN = "arn:aws:elasticloadbalancing:eu-central-1:1:loadbalancer/app/web/abc";

afterEach(() => _resetClientsForTests());

describe("describeTargetGroupsSchema", () => {
	test("accepts no selector (lists all) with the pagination aliases", () => {
		expect(describeTargetGroupsSchema.safeParse({ limit: 50, cursor: "tok" }).success).toBe(true);
	});

	test("accepts each selector alone", () => {
		expect(describeTargetGroupsSchema.safeParse({ loadBalancerArn: LB_ARN }).success).toBe(true);
		expect(describeTargetGroupsSchema.safeParse({ targetGroupArns: ["arn:tg1"] }).success).toBe(true);
		expect(describeTargetGroupsSchema.safeParse({ names: ["orders-tg"] }).success).toBe(true);
	});

	test("rejects non-array targetGroupArns", () => {
		expect(describeTargetGroupsSchema.safeParse({ targetGroupArns: "arn:tg1" }).success).toBe(false);
	});
});

describe("describeTargetGroups handler", () => {
	// The at-most-one-selector guard lives in the handler (not a schema .refine)
	// because only the schema's .shape survives registration.
	test("two selectors -> bad-input _error, no SDK call", async () => {
		const elbMock = mockClient(ElasticLoadBalancingV2Client);
		elbMock.on(DescribeTargetGroupsCommand).resolves({ TargetGroups: [] });

		const handler = describeTargetGroups(config);
		const result = (await handler({ estate: "prod", loadBalancerArn: LB_ARN, names: ["orders-tg"] })) as {
			_error: ToolError;
		};
		expect(result._error.kind).toBe("bad-input");
		expect(result._error.awsErrorMessage).toContain("at most one of loadBalancerArn, targetGroupArns, or names");
		expect(elbMock.commandCalls(DescribeTargetGroupsCommand)).toHaveLength(0);
	});

	test("all three selectors -> bad-input _error", async () => {
		mockClient(ElasticLoadBalancingV2Client).on(DescribeTargetGroupsCommand).resolves({ TargetGroups: [] });

		const handler = describeTargetGroups(config);
		const result = (await handler({
			estate: "prod",
			loadBalancerArn: LB_ARN,
			targetGroupArns: ["arn:tg1"],
			names: ["orders-tg"],
		})) as { _error: ToolError };
		expect(result._error.kind).toBe("bad-input");
	});

	test("no selector lists all target groups", async () => {
		const elbMock = mockClient(ElasticLoadBalancingV2Client);
		elbMock.on(DescribeTargetGroupsCommand).resolves({ TargetGroups: [{ TargetGroupArn: "arn:tg1" }] });

		const handler = describeTargetGroups(config);
		const result = (await handler({ estate: "prod" })) as { TargetGroups: { TargetGroupArn: string }[] };
		expect(result.TargetGroups[0]?.TargetGroupArn).toBe("arn:tg1");
	});

	test("cursor->Marker and limit->PageSize reach the SDK command", async () => {
		const elbMock = mockClient(ElasticLoadBalancingV2Client);
		elbMock.on(DescribeTargetGroupsCommand).resolves({ TargetGroups: [] });

		const handler = describeTargetGroups(config);
		await handler({ estate: "prod", loadBalancerArn: LB_ARN, cursor: "tok-1", limit: 25 });
		const call = elbMock.commandCalls(DescribeTargetGroupsCommand)[0];
		expect(call?.args[0].input.Marker).toBe("tok-1");
		expect(call?.args[0].input.PageSize).toBe(25);
	});
});

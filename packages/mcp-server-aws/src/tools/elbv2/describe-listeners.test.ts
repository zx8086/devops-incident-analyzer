// src/tools/elbv2/describe-listeners.test.ts
import { afterEach, describe, expect, test } from "bun:test";
import { DescribeListenersCommand, ElasticLoadBalancingV2Client } from "@aws-sdk/client-elastic-load-balancing-v2";
import { mockClient } from "aws-sdk-client-mock";
import type { AwsConfig } from "../../config/schemas.ts";
import { _resetClientsForTests } from "../../services/client-factory.ts";
import type { ToolError } from "../types.ts";
import { describeListeners, describeListenersSchema } from "./describe-listeners.ts";

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

describe("describeListenersSchema", () => {
	test("accepts loadBalancerArn alone", () => {
		expect(describeListenersSchema.safeParse({ loadBalancerArn: LB_ARN }).success).toBe(true);
	});

	test("accepts listenerArns alone with the pagination aliases", () => {
		expect(describeListenersSchema.safeParse({ listenerArns: ["arn:l1"], limit: 25, cursor: "tok" }).success).toBe(
			true,
		);
	});

	test("rejects non-array listenerArns", () => {
		expect(describeListenersSchema.safeParse({ listenerArns: "arn:l1" }).success).toBe(false);
	});

	test("rejects an empty listenerArns array", () => {
		expect(describeListenersSchema.safeParse({ listenerArns: [] }).success).toBe(false);
	});
});

describe("describeListeners handler", () => {
	// SIO-1205: the XOR guard lives in the handler (not a schema .refine) because only the
	// schema's .shape survives registration. Both violations must map to a bad-input _error.
	test("neither loadBalancerArn nor listenerArns -> bad-input _error, no SDK call", async () => {
		const elbMock = mockClient(ElasticLoadBalancingV2Client);
		elbMock.on(DescribeListenersCommand).resolves({ Listeners: [] });

		const handler = describeListeners(config);
		const result = (await handler({ estate: "prod" })) as { _error: ToolError };
		expect(result._error.kind).toBe("bad-input");
		expect(result._error.awsErrorMessage).toContain("exactly one of loadBalancerArn or listenerArns");
		expect(elbMock.commandCalls(DescribeListenersCommand)).toHaveLength(0);
	});

	test("both loadBalancerArn and listenerArns -> bad-input _error", async () => {
		mockClient(ElasticLoadBalancingV2Client).on(DescribeListenersCommand).resolves({ Listeners: [] });

		const handler = describeListeners(config);
		const result = (await handler({ estate: "prod", loadBalancerArn: LB_ARN, listenerArns: ["arn:l1"] })) as {
			_error: ToolError;
		};
		expect(result._error.kind).toBe("bad-input");
	});

	test("returns Listeners[] whose DefaultActions carry the TargetGroupArn routing link", async () => {
		const elbMock = mockClient(ElasticLoadBalancingV2Client);
		elbMock.on(DescribeListenersCommand).resolves({
			Listeners: [
				{
					ListenerArn: "arn:l1",
					Port: 443,
					Protocol: "HTTPS",
					DefaultActions: [{ Type: "forward", TargetGroupArn: "arn:tg1" }],
				},
			],
		});

		const handler = describeListeners(config);
		const result = (await handler({ estate: "prod", loadBalancerArn: LB_ARN })) as {
			Listeners: { DefaultActions: { TargetGroupArn: string }[] }[];
		};
		expect(result.Listeners[0]?.DefaultActions[0]?.TargetGroupArn).toBe("arn:tg1");
		expect(elbMock.commandCalls(DescribeListenersCommand)[0]?.args[0].input.LoadBalancerArn).toBe(LB_ARN);
	});

	test("cursor->Marker and limit->PageSize reach the SDK command", async () => {
		const elbMock = mockClient(ElasticLoadBalancingV2Client);
		elbMock.on(DescribeListenersCommand).resolves({ Listeners: [] });

		const handler = describeListeners(config);
		await handler({ estate: "prod", loadBalancerArn: LB_ARN, cursor: "tok-1", limit: 25 });
		const call = elbMock.commandCalls(DescribeListenersCommand)[0];
		expect(call?.args[0].input.Marker).toBe("tok-1");
		expect(call?.args[0].input.PageSize).toBe(25);
	});
});

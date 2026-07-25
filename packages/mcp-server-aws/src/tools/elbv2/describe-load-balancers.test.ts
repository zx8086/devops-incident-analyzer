// src/tools/elbv2/describe-load-balancers.test.ts
import { afterEach, describe, expect, test } from "bun:test";
import { DescribeLoadBalancersCommand, ElasticLoadBalancingV2Client } from "@aws-sdk/client-elastic-load-balancing-v2";
import { mockClient } from "aws-sdk-client-mock";
import type { AwsConfig } from "../../config/schemas.ts";
import { _resetClientsForTests } from "../../services/client-factory.ts";
import {
	describeLoadBalancers,
	describeLoadBalancersSchema,
	summarizeLoadBalancers,
} from "./describe-load-balancers.ts";

const config: AwsConfig = {
	region: "eu-central-1",
	estates: {
		prod: {
			assumedRoleArn: "arn:aws:iam::356994971776:role/DevOpsAgentReadOnly",
			externalId: "aws-mcp-readonly-2026",
		},
	},
};

afterEach(() => _resetClientsForTests());

describe("describeLoadBalancersSchema", () => {
	test("accepts empty input", () => {
		expect(describeLoadBalancersSchema.safeParse({}).success).toBe(true);
	});

	test("accepts the SIO-838 limit and cursor aliases", () => {
		expect(describeLoadBalancersSchema.safeParse({ limit: 50, cursor: "tok" }).success).toBe(true);
	});

	test("limit alias inherits the PageSize 1-400 bounds", () => {
		expect(describeLoadBalancersSchema.safeParse({ limit: 0 }).success).toBe(false);
		expect(describeLoadBalancersSchema.safeParse({ limit: 401 }).success).toBe(false);
	});

	test("rejects non-array loadBalancerArns", () => {
		expect(describeLoadBalancersSchema.safeParse({ loadBalancerArns: "arn:..." }).success).toBe(false);
	});
});

describe("describeLoadBalancers alias wiring", () => {
	test("cursor->Marker and limit->PageSize reach the SDK command", async () => {
		const elbMock = mockClient(ElasticLoadBalancingV2Client);
		elbMock.on(DescribeLoadBalancersCommand).resolves({ LoadBalancers: [] });

		const handler = describeLoadBalancers(config);
		await handler({ estate: "prod", cursor: "tok-1", limit: 25 });
		const call = elbMock.commandCalls(DescribeLoadBalancersCommand)[0];
		expect(call?.args[0].input.Marker).toBe("tok-1");
		expect(call?.args[0].input.PageSize).toBe(25);
	});

	test("SDK-named marker/pageSize win over the aliases", async () => {
		const elbMock = mockClient(ElasticLoadBalancingV2Client);
		elbMock.on(DescribeLoadBalancersCommand).resolves({ LoadBalancers: [] });

		const handler = describeLoadBalancers(config);
		await handler({ estate: "prod", marker: "sdk-tok", cursor: "alias-tok", pageSize: 10, limit: 99 });
		const call = elbMock.commandCalls(DescribeLoadBalancersCommand)[0];
		expect(call?.args[0].input.Marker).toBe("sdk-tok");
		expect(call?.args[0].input.PageSize).toBe(10);
	});
});

describe("summarizeLoadBalancers", () => {
	test("projects the network-map scalar fields only", () => {
		const summary = summarizeLoadBalancers({
			LoadBalancers: [
				{
					LoadBalancerArn: "arn:aws:elasticloadbalancing:eu-central-1:1:loadbalancer/app/web/abc",
					DNSName: "web-123.eu-central-1.elb.amazonaws.com",
					Type: "application",
					Scheme: "internet-facing",
					VpcId: "vpc-1",
					SecurityGroups: ["sg-1"],
					AvailabilityZones: [{ ZoneName: "eu-central-1a" }],
				},
			],
		});
		expect(summary).toEqual([
			{
				LoadBalancerArn: "arn:aws:elasticloadbalancing:eu-central-1:1:loadbalancer/app/web/abc",
				DNSName: "web-123.eu-central-1.elb.amazonaws.com",
				Type: "application",
				Scheme: "internet-facing",
				VpcId: "vpc-1",
			},
		]);
	});

	test("missing LoadBalancers -> empty array", () => {
		expect(summarizeLoadBalancers({})).toEqual([]);
	});
});

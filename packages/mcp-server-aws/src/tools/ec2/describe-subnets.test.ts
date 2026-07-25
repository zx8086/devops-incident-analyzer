// src/tools/ec2/describe-subnets.test.ts
import { afterEach, describe, expect, test } from "bun:test";
import { DescribeSubnetsCommand, EC2Client } from "@aws-sdk/client-ec2";
import { mockClient } from "aws-sdk-client-mock";
import type { AwsConfig } from "../../config/schemas.ts";
import { _resetClientsForTests } from "../../services/client-factory.ts";
import { describeSubnets, describeSubnetsSchema } from "./describe-subnets.ts";

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

describe("describeSubnetsSchema", () => {
	test("accepts empty input and the vpc-id filter", () => {
		expect(describeSubnetsSchema.safeParse({}).success).toBe(true);
		expect(describeSubnetsSchema.safeParse({ filters: [{ Name: "vpc-id", Values: ["vpc-1"] }] }).success).toBe(true);
	});

	test("rejects non-array subnetIds", () => {
		expect(describeSubnetsSchema.safeParse({ subnetIds: "subnet-1" }).success).toBe(false);
	});

	test("maxResults and the limit alias inherit the EC2 5-1000 bounds", () => {
		expect(describeSubnetsSchema.safeParse({ maxResults: 5 }).success).toBe(true);
		expect(describeSubnetsSchema.safeParse({ maxResults: 4 }).success).toBe(false);
		expect(describeSubnetsSchema.safeParse({ maxResults: 1001 }).success).toBe(false);
		expect(describeSubnetsSchema.safeParse({ limit: 1000 }).success).toBe(true);
		expect(describeSubnetsSchema.safeParse({ limit: 4 }).success).toBe(false);
	});
});

describe("describeSubnets handler", () => {
	test("cursor->NextToken and limit->MaxResults reach the SDK command", async () => {
		const ec2Mock = mockClient(EC2Client);
		ec2Mock.on(DescribeSubnetsCommand).resolves({ Subnets: [] });

		const handler = describeSubnets(config);
		await handler({ estate: "prod", cursor: "tok-1", limit: 25 });
		const call = ec2Mock.commandCalls(DescribeSubnetsCommand)[0];
		expect(call?.args[0].input.NextToken).toBe("tok-1");
		expect(call?.args[0].input.MaxResults).toBe(25);
	});

	test("SDK params win over the canonical aliases", async () => {
		const ec2Mock = mockClient(EC2Client);
		ec2Mock.on(DescribeSubnetsCommand).resolves({ Subnets: [] });

		const handler = describeSubnets(config);
		await handler({ estate: "prod", nextToken: "sdk-tok", cursor: "alias-tok", maxResults: 50, limit: 25 });
		const call = ec2Mock.commandCalls(DescribeSubnetsCommand)[0];
		expect(call?.args[0].input.NextToken).toBe("sdk-tok");
		expect(call?.args[0].input.MaxResults).toBe(50);
	});

	test("forwards subnetIds and filters", async () => {
		const ec2Mock = mockClient(EC2Client);
		ec2Mock.on(DescribeSubnetsCommand).resolves({ Subnets: [{ SubnetId: "subnet-1" }] });

		const handler = describeSubnets(config);
		const result = (await handler({
			estate: "prod",
			subnetIds: ["subnet-1"],
			filters: [{ Name: "vpc-id", Values: ["vpc-1"] }],
		})) as { Subnets: { SubnetId: string }[] };
		expect(result.Subnets[0]?.SubnetId).toBe("subnet-1");
		const call = ec2Mock.commandCalls(DescribeSubnetsCommand)[0];
		expect(call?.args[0].input.SubnetIds).toEqual(["subnet-1"]);
		expect(call?.args[0].input.Filters).toEqual([{ Name: "vpc-id", Values: ["vpc-1"] }]);
	});
});

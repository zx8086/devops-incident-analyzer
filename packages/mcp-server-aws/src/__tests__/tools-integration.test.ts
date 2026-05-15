// src/__tests__/tools-integration.test.ts
// One representative integration test per family, using aws-sdk-client-mock.
// Verifies the tool handler calls the SDK with the right params and the
// response flows through the wrapper correctly.
import { afterEach, describe, expect, test } from "bun:test";
import { DescribeVpcsCommand, EC2Client } from "@aws-sdk/client-ec2";
import { mockClient } from "aws-sdk-client-mock";
import type { AwsConfig } from "../config/schemas.ts";
import { _resetClientsForTests } from "../services/client-factory.ts";
import { describeVpcs } from "../tools/ec2/describe-vpcs.ts";

const config: AwsConfig = {
	region: "eu-central-1",
	assumedRoleArn: "arn:aws:iam::356994971776:role/DevOpsAgentReadOnly",
	externalId: "aws-mcp-readonly-2026",
};

afterEach(() => _resetClientsForTests());

describe("ec2 integration", () => {
	test("describeVpcs returns SDK response unchanged when under cap", async () => {
		const ec2Mock = mockClient(EC2Client);
		ec2Mock.on(DescribeVpcsCommand).resolves({ Vpcs: [{ VpcId: "vpc-1", CidrBlock: "10.0.0.0/16" }] });

		const handler = describeVpcs(config);
		const result = (await handler({})) as { Vpcs: unknown[] };
		expect(result.Vpcs).toHaveLength(1);
	});
});

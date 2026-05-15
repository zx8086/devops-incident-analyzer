// src/__tests__/client-factory.test.ts
import { afterEach, describe, expect, test } from "bun:test";
import { EC2Client } from "@aws-sdk/client-ec2";
import { S3Client } from "@aws-sdk/client-s3";
import type { AwsConfig } from "../config/schemas.ts";
import { _resetClientsForTests, getEc2Client, getS3Client } from "../services/client-factory.ts";

const config: AwsConfig = {
	region: "eu-central-1",
	assumedRoleArn: "arn:aws:iam::356994971776:role/DevOpsAgentReadOnly",
	externalId: "aws-mcp-readonly-2026",
};

afterEach(() => _resetClientsForTests());

describe("client-factory", () => {
	test("getEc2Client returns an EC2Client", () => {
		expect(getEc2Client(config)).toBeInstanceOf(EC2Client);
	});

	test("getEc2Client returns the same instance on repeated calls (singleton)", () => {
		const a = getEc2Client(config);
		const b = getEc2Client(config);
		expect(a).toBe(b);
	});

	test("different service factories produce different client classes", () => {
		const ec2 = getEc2Client(config);
		const s3 = getS3Client(config);
		expect(ec2).toBeInstanceOf(EC2Client);
		expect(s3).toBeInstanceOf(S3Client);
		expect(ec2 as unknown).not.toBe(s3 as unknown);
	});

	test("client uses the configured region", async () => {
		const client = getEc2Client(config);
		const region = await client.config.region();
		expect(region).toBe("eu-central-1");
	});
});

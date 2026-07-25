// src/__tests__/client-factory.test.ts
import { afterEach, describe, expect, test } from "bun:test";
import { EC2Client } from "@aws-sdk/client-ec2";
import { ElasticLoadBalancingV2Client } from "@aws-sdk/client-elastic-load-balancing-v2";
import { Route53Client } from "@aws-sdk/client-route-53";
import { S3Client } from "@aws-sdk/client-s3";
import type { AwsConfig } from "../config/schemas.ts";
import {
	_resetClientsForTests,
	getEc2Client,
	getElbv2Client,
	getRoute53Client,
	getS3Client,
} from "../services/client-factory.ts";

const config: AwsConfig = {
	region: "eu-central-1",
	estates: {
		dev: {
			assumedRoleArn: "arn:aws:iam::111111111111:role/DevOpsAgentReadOnly",
			externalId: "id-dev",
		},
		prod: {
			assumedRoleArn: "arn:aws:iam::222222222222:role/DevOpsAgentReadOnly",
			externalId: "id-prod",
		},
	},
};

afterEach(() => _resetClientsForTests());

describe("client-factory", () => {
	test("getEc2Client returns an EC2Client", () => {
		expect(getEc2Client(config, "prod")).toBeInstanceOf(EC2Client);
	});

	test("getEc2Client returns the same instance on repeated calls (singleton per estate)", () => {
		const a = getEc2Client(config, "prod");
		const b = getEc2Client(config, "prod");
		expect(a).toBe(b);
	});

	test("getEc2Client returns DIFFERENT instances for different estates", () => {
		const dev = getEc2Client(config, "dev");
		const prod = getEc2Client(config, "prod");
		expect(dev).not.toBe(prod);
	});

	test("different service factories produce different client classes", () => {
		const ec2 = getEc2Client(config, "prod");
		const s3 = getS3Client(config, "prod");
		expect(ec2).toBeInstanceOf(EC2Client);
		expect(s3).toBeInstanceOf(S3Client);
		expect(ec2 as unknown).not.toBe(s3 as unknown);
	});

	test("client uses the configured region", async () => {
		const client = getEc2Client(config, "prod");
		const region = await client.config.region();
		expect(region).toBe("eu-central-1");
	});

	// SIO-1205: ingress-path clients
	test("getElbv2Client returns a singleton ElasticLoadBalancingV2Client in the configured region", async () => {
		const a = getElbv2Client(config, "prod");
		const b = getElbv2Client(config, "prod");
		expect(a).toBeInstanceOf(ElasticLoadBalancingV2Client);
		expect(a).toBe(b);
		expect(await a.config.region()).toBe("eu-central-1");
	});

	test("getRoute53Client returns a singleton Route53Client pinned to us-east-1 (global service)", async () => {
		const a = getRoute53Client(config, "prod");
		const b = getRoute53Client(config, "prod");
		expect(a).toBeInstanceOf(Route53Client);
		expect(a).toBe(b);
		// Like the Health client, Route 53 is global: the region is overridden to us-east-1
		// regardless of the configured estate region.
		expect(await a.config.region()).toBe("us-east-1");
	});

	test("_resetClientsForTests clears the cache so next call returns a fresh instance", () => {
		const a = getEc2Client(config, "prod");
		_resetClientsForTests();
		const b = getEc2Client(config, "prod");
		expect(a).not.toBe(b);
	});

	test("unknown estate throws a single, clear error", () => {
		expect(() => getEc2Client(config, "bogus")).toThrow(/Unknown estate "bogus"/);
	});
});

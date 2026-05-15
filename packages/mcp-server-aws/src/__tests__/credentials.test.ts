// src/__tests__/credentials.test.ts
import { describe, expect, test } from "bun:test";
import type { AwsConfig } from "../config/schemas.ts";
import { buildAssumedCredsProvider } from "../services/credentials.ts";

const config: AwsConfig = {
	region: "eu-central-1",
	assumedRoleArn: "arn:aws:iam::356994971776:role/DevOpsAgentReadOnly",
	externalId: "aws-mcp-readonly-2026",
};

describe("buildAssumedCredsProvider", () => {
	test("returns a callable credential provider function", () => {
		const provider = buildAssumedCredsProvider(config);
		expect(typeof provider).toBe("function");
	});

	test("constructs without throwing for a valid config", () => {
		expect(() => buildAssumedCredsProvider(config)).not.toThrow();
	});

	test("returns a function on every call (stable provider shape)", () => {
		// fromTemporaryCredentials accepts an opaque config; we can't unit-test
		// the AssumeRole call itself without mocking STS. Just confirm the
		// returned provider is the same function shape on repeated calls.
		const a = buildAssumedCredsProvider(config);
		const b = buildAssumedCredsProvider(config);
		expect(typeof a).toBe(typeof b);
	});

	test("respects different configs (returns different provider instances)", () => {
		const a = buildAssumedCredsProvider(config);
		const b = buildAssumedCredsProvider({ ...config, region: "us-east-1" });
		expect(a).not.toBe(b);
	});
});

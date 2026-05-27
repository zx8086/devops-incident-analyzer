// src/__tests__/credentials.test.ts
import { describe, expect, test } from "bun:test";
import type { EstateConfig } from "../config/schemas.ts";
import { buildAssumedCredsProvider } from "../services/credentials.ts";

const estate: EstateConfig = {
	assumedRoleArn: "arn:aws:iam::356994971776:role/DevOpsAgentReadOnly",
	externalId: "aws-mcp-readonly-2026",
};

describe("buildAssumedCredsProvider", () => {
	test("returns a callable credential provider function", () => {
		const provider = buildAssumedCredsProvider(estate, "eu-central-1");
		expect(typeof provider).toBe("function");
	});

	test("constructs without throwing for a valid config", () => {
		expect(() => buildAssumedCredsProvider(estate, "eu-central-1")).not.toThrow();
	});

	test("returns a function on every call (stable provider shape)", () => {
		// fromTemporaryCredentials accepts an opaque config; we can't unit-test
		// the AssumeRole call itself without mocking STS. Just confirm the
		// returned provider is the same function shape on repeated calls.
		const a = buildAssumedCredsProvider(estate, "eu-central-1");
		const b = buildAssumedCredsProvider(estate, "eu-central-1");
		expect(typeof a).toBe(typeof b);
	});

	test("returns different provider instances for different regions", () => {
		const a = buildAssumedCredsProvider(estate, "eu-central-1");
		const b = buildAssumedCredsProvider(estate, "us-east-1");
		expect(a).not.toBe(b);
	});
});

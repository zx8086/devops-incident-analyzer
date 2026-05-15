// src/__tests__/config.test.ts
import { describe, expect, test } from "bun:test";
import { ConfigSchema, loadConfig } from "../config/index.ts";

describe("ConfigSchema", () => {
	const validEnv = {
		AWS_REGION: "eu-central-1",
		AWS_ASSUMED_ROLE_ARN: "arn:aws:iam::356994971776:role/DevOpsAgentReadOnly",
		AWS_EXTERNAL_ID: "aws-mcp-readonly-2026",
	};

	test("accepts complete env with all required fields", () => {
		const result = ConfigSchema.safeParse(validEnv);
		expect(result.success).toBe(true);
	});

	test("rejects when AWS_REGION is missing", () => {
		const { AWS_REGION: _, ...rest } = validEnv;
		const result = ConfigSchema.safeParse(rest);
		expect(result.success).toBe(false);
	});

	test("rejects malformed role ARN", () => {
		const result = ConfigSchema.safeParse({
			...validEnv,
			AWS_ASSUMED_ROLE_ARN: "not-an-arn",
		});
		expect(result.success).toBe(false);
	});

	test("uses default port 9085 when TRANSPORT_PORT is missing", () => {
		const result = ConfigSchema.parse(validEnv);
		expect(result.transport.port).toBe(9085);
	});

	test("respects SUBAGENT_TOOL_RESULT_CAP_BYTES override", () => {
		const result = ConfigSchema.parse({
			...validEnv,
			SUBAGENT_TOOL_RESULT_CAP_BYTES: "4096",
		});
		expect(result.toolResultCapBytes).toBe(4096);
	});

	test("loadConfig is idempotent (returns the same object on repeated calls)", () => {
		const a = loadConfig(validEnv);
		const b = loadConfig(validEnv);
		expect(a).toEqual(b);
	});
});

// src/__tests__/config.test.ts
import { describe, expect, test } from "bun:test";
import { _resetConfigCacheForTests, ConfigSchema, getConfig, loadConfig } from "../config/index.ts";

describe("ConfigSchema", () => {
	const validEnv = {
		AWS_REGION: "eu-central-1",
		AWS_ESTATES: JSON.stringify({
			prod: {
				assumedRoleArn: "arn:aws:iam::356994971776:role/DevOpsAgentReadOnly",
				externalId: "aws-mcp-readonly-2026",
			},
		}),
	};

	test("accepts complete env with all required fields", () => {
		const result = ConfigSchema.safeParse(validEnv);
		expect(result.success).toBe(true);
		if (result.success) {
			expect(Object.keys(result.data.aws.estates)).toEqual(["prod"]);
		}
	});

	test("accepts multiple estates", () => {
		const result = ConfigSchema.safeParse({
			...validEnv,
			AWS_ESTATES: JSON.stringify({
				dev: { assumedRoleArn: "arn:aws:iam::111111111111:role/Foo", externalId: "id-dev" },
				prod: { assumedRoleArn: "arn:aws:iam::222222222222:role/Foo", externalId: "id-prod" },
			}),
		});
		expect(result.success).toBe(true);
		if (result.success) {
			expect(Object.keys(result.data.aws.estates).sort()).toEqual(["dev", "prod"]);
		}
	});

	test("rejects when AWS_REGION is missing", () => {
		const { AWS_REGION: _, ...rest } = validEnv;
		const result = ConfigSchema.safeParse(rest);
		expect(result.success).toBe(false);
	});

	test("rejects when AWS_ESTATES is missing", () => {
		const { AWS_ESTATES: _, ...rest } = validEnv;
		const result = ConfigSchema.safeParse(rest);
		expect(result.success).toBe(false);
	});

	test("rejects when AWS_ESTATES is not valid JSON", () => {
		const result = ConfigSchema.safeParse({ ...validEnv, AWS_ESTATES: "{not-json" });
		expect(result.success).toBe(false);
	});

	test("rejects when AWS_ESTATES is empty object", () => {
		const result = ConfigSchema.safeParse({ ...validEnv, AWS_ESTATES: "{}" });
		expect(result.success).toBe(false);
	});

	test("rejects malformed role ARN inside estate", () => {
		const result = ConfigSchema.safeParse({
			...validEnv,
			AWS_ESTATES: JSON.stringify({
				prod: { assumedRoleArn: "not-an-arn", externalId: "id" },
			}),
		});
		expect(result.success).toBe(false);
	});

	test("rejects estate ID with invalid characters", () => {
		const result = ConfigSchema.safeParse({
			...validEnv,
			AWS_ESTATES: JSON.stringify({
				Prod_Bad: { assumedRoleArn: "arn:aws:iam::111111111111:role/X", externalId: "id" },
			}),
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

	test("getConfig() returns same reference after loadConfig populates cache", () => {
		_resetConfigCacheForTests();
		loadConfig(validEnv);
		const a = getConfig();
		const b = getConfig();
		expect(a).toBe(b);
	});
});

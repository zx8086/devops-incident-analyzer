// tests/unit/config/cloud-config.test.ts

import { describe, expect, test } from "bun:test";
import { cloudDefaults } from "../../../src/config/defaults.js";
import { ElasticCloudConfigSchema, getConfig, validateEnvironment } from "../../../src/config/index.js";

describe("SIO-674: Cloud + Billing config", () => {
	test("config.cloud reflects EC_API_KEY presence", () => {
		const config = getConfig();
		if (Bun.env.EC_API_KEY) {
			expect(config.cloud).toBeDefined();
			expect(config.cloud?.apiKey).toBe(Bun.env.EC_API_KEY);
			expect(config.cloud?.endpoint).toBe(Bun.env.EC_API_ENDPOINT ?? cloudDefaults.endpoint);
			expect(typeof config.cloud?.requestTimeout).toBe("number");
			expect(typeof config.cloud?.maxRetries).toBe("number");
		} else {
			expect(config.cloud).toBeUndefined();
		}
	});

	test("ElasticCloudConfigSchema accepts a fully populated value", () => {
		const parsed = ElasticCloudConfigSchema.parse({
			apiKey: "test-key",
			endpoint: "https://api.elastic-cloud.com",
			defaultOrgId: "org-123",
			requestTimeout: 30000,
			maxRetries: 3,
		});
		expect(parsed.apiKey).toBe("test-key");
		expect(parsed.defaultOrgId).toBe("org-123");
	});

	test("ElasticCloudConfigSchema rejects empty apiKey", () => {
		expect(() =>
			ElasticCloudConfigSchema.parse({
				apiKey: "",
				endpoint: "https://api.elastic-cloud.com",
				requestTimeout: 30000,
				maxRetries: 3,
			}),
		).toThrow();
	});

	test("ElasticCloudConfigSchema rejects malformed endpoint", () => {
		expect(() =>
			ElasticCloudConfigSchema.parse({
				apiKey: "test-key",
				endpoint: "not-a-url",
				requestTimeout: 30000,
				maxRetries: 3,
			}),
		).toThrow();
	});

	test("ElasticCloudConfigSchema enforces requestTimeout bounds", () => {
		expect(() =>
			ElasticCloudConfigSchema.parse({
				apiKey: "test-key",
				endpoint: "https://api.elastic-cloud.com",
				requestTimeout: 100, // below 1000 minimum
				maxRetries: 3,
			}),
		).toThrow();
	});

	test("validateEnvironment emits a warning when EC_API_KEY is unset", () => {
		const result = validateEnvironment();
		if (!Bun.env.EC_API_KEY) {
			expect(result.warnings ?? []).toEqual(
				expect.arrayContaining([expect.stringMatching(/EC_API_KEY not set.*will not register/)]),
			);
		}
	});

	test("cloudDefaults exports expected default values", () => {
		expect(cloudDefaults.endpoint).toBe("https://api.elastic-cloud.com");
		expect(cloudDefaults.requestTimeout).toBe(30000);
		expect(cloudDefaults.maxRetries).toBe(3);
	});
});

// apps/web/src/routes/health/server.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

const { GET } = await import("./+server.ts");

const ENV_KEYS = ["ELASTIC_MCP_URL", "KAFKA_MCP_URL", "COUCHBASE_MCP_URL", "KONNECT_MCP_URL"] as const;
type EnvKey = (typeof ENV_KEYS)[number];

describe("GET /health", () => {
	const original: Partial<Record<EnvKey, string | undefined>> = {};

	beforeEach(() => {
		for (const key of ENV_KEYS) {
			original[key] = process.env[key];
			delete process.env[key];
		}
	});

	afterEach(() => {
		for (const key of ENV_KEYS) {
			if (original[key] === undefined) delete process.env[key];
			else process.env[key] = original[key];
		}
	});

	test("returns ok with all services false when no MCP URLs configured", async () => {
		const response = await GET({} as Parameters<typeof GET>[0]);
		expect(response.status).toBe(200);
		const body = (await response.json()) as {
			status: string;
			timestamp: string;
			services: Record<string, boolean>;
		};
		expect(body.status).toBe("ok");
		expect(typeof body.timestamp).toBe("string");
		expect(Number.isNaN(Date.parse(body.timestamp))).toBe(false);
		expect(body.services).toEqual({
			elastic: false,
			kafka: false,
			couchbase: false,
			konnect: false,
		});
	});

	test("reflects configured MCP URLs as true", async () => {
		process.env.ELASTIC_MCP_URL = "http://localhost:9080";
		process.env.KAFKA_MCP_URL = "http://localhost:9081";
		const response = await GET({} as Parameters<typeof GET>[0]);
		const body = (await response.json()) as { services: Record<string, boolean> };
		expect(body.services.elastic).toBe(true);
		expect(body.services.kafka).toBe(true);
		expect(body.services.couchbase).toBe(false);
		expect(body.services.konnect).toBe(false);
	});
});

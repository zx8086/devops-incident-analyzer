// tests/unit/clients/cloudClient.test.ts

import { describe, expect, test } from "bun:test";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import { CloudClient, type FetchLike } from "../../../src/clients/cloudClient.js";
import type { ElasticCloudConfig } from "../../../src/config/schemas.js";

const baseCloudConfig: ElasticCloudConfig = {
	apiKey: "test-api-key",
	endpoint: "https://api.elastic-cloud.com",
	defaultOrgId: "org-1",
	requestTimeout: 5000,
	maxRetries: 0,
};

interface FetchCall {
	url: string;
	init: RequestInit | undefined;
}

function recordingFetch(handlers: Array<(call: FetchCall) => Response | Promise<Response>>): {
	fetchImpl: FetchLike;
	calls: FetchCall[];
} {
	const calls: FetchCall[] = [];
	let i = 0;
	const fetchImpl: FetchLike = async (url, init) => {
		const call: FetchCall = { url: typeof url === "string" ? url : String(url), init };
		calls.push(call);
		const handler = handlers[Math.min(i, handlers.length - 1)];
		i++;
		if (!handler) throw new Error("recordingFetch: handler unset");
		return handler(call);
	};
	return { fetchImpl, calls };
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
	return new Response(JSON.stringify(body), {
		status: init.status ?? 200,
		statusText: init.statusText,
		headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
	});
}

describe("CloudClient", () => {
	test("get() builds the URL, attaches ApiKey header, decodes JSON", async () => {
		const { fetchImpl, calls } = recordingFetch([() => jsonResponse({ deployments: [{ id: "abc" }] })]);
		const client = new CloudClient(baseCloudConfig, fetchImpl);

		const result = await client.get<{ deployments: Array<{ id: string }> }>("/api/v1/deployments");

		expect(result.deployments[0]?.id).toBe("abc");
		expect(calls[0]?.url).toBe("https://api.elastic-cloud.com/api/v1/deployments");
		const headers = calls[0]?.init?.headers as Record<string, string>;
		expect(headers?.Authorization).toBe("ApiKey test-api-key");
		expect(headers?.Accept).toBe("application/json");
	});

	test("get() appends query parameters and skips undefined values", async () => {
		const { fetchImpl, calls } = recordingFetch([() => jsonResponse({})]);
		const client = new CloudClient(baseCloudConfig, fetchImpl);

		await client.get("/api/v1/billing/costs/organizations/org-1/items", {
			query: { from: "2026-01-01", to: undefined, page_size: 10 },
		});

		const url = new URL(calls[0]?.url ?? "");
		expect(url.searchParams.get("from")).toBe("2026-01-01");
		expect(url.searchParams.get("to")).toBeNull();
		expect(url.searchParams.get("page_size")).toBe("10");
	});

	test("normalises endpoint trailing slash and missing leading slash on path", async () => {
		const { fetchImpl, calls } = recordingFetch([() => jsonResponse({})]);
		const client = new CloudClient({ ...baseCloudConfig, endpoint: "https://api.elastic-cloud.com/" }, fetchImpl);
		await client.get("api/v1/deployments");
		expect(calls[0]?.url).toBe("https://api.elastic-cloud.com/api/v1/deployments");
	});

	test("4xx response throws McpError with InvalidParams code and truncated body", async () => {
		const { fetchImpl } = recordingFetch([
			() => new Response("forbidden detail", { status: 403, statusText: "Forbidden" }),
		]);
		const client = new CloudClient(baseCloudConfig, fetchImpl);

		await expect(client.get("/api/v1/deployments")).rejects.toThrow(McpError);
		try {
			await client.get("/api/v1/deployments");
		} catch (e) {
			expect(e).toBeInstanceOf(McpError);
			expect((e as McpError).message).toContain("403");
			expect((e as McpError).data).toMatchObject({ status: 403, body: expect.stringContaining("forbidden") });
		}
	});

	test("5xx response retries with backoff and eventually returns success", async () => {
		const { fetchImpl, calls } = recordingFetch([
			() => new Response("upstream", { status: 502 }),
			() => jsonResponse({ ok: true }),
		]);
		const client = new CloudClient({ ...baseCloudConfig, maxRetries: 2 }, fetchImpl);

		const result = await client.get<{ ok: boolean }>("/api/v1/deployments");
		expect(result.ok).toBe(true);
		expect(calls.length).toBe(2);
	});

	test("5xx response that exhausts retries throws McpError with InternalError", async () => {
		const { fetchImpl, calls } = recordingFetch([() => new Response("still 503", { status: 503 })]);
		const client = new CloudClient({ ...baseCloudConfig, maxRetries: 1 }, fetchImpl);

		await expect(client.get("/api/v1/deployments")).rejects.toThrow(McpError);
		// 1 initial + 1 retry = 2 calls
		expect(calls.length).toBe(2);
	});

	test("network error retries and propagates after exhaustion", async () => {
		const { fetchImpl, calls } = recordingFetch([
			() => {
				throw new Error("ECONNRESET");
			},
		]);
		const client = new CloudClient({ ...baseCloudConfig, maxRetries: 1 }, fetchImpl);

		await expect(client.get("/api/v1/deployments")).rejects.toThrow(McpError);
		expect(calls.length).toBe(2);
	});

	test("redacts api_key query parameter in error messages", async () => {
		const { fetchImpl } = recordingFetch([() => new Response("denied", { status: 401 })]);
		const client = new CloudClient(baseCloudConfig, fetchImpl);

		try {
			await client.get("/api/v1/deployments", { query: { api_key: "should-be-hidden" } });
		} catch (e) {
			// URL.searchParams.set() URL-encodes the value, so [REDACTED] becomes %5BREDACTED%5D
			expect((e as McpError).message).toContain("%5BREDACTED%5D");
			expect((e as McpError).message).not.toContain("should-be-hidden");
		}
	});

	test("defaultOrgId is exposed for billing tools to consume", () => {
		const client = new CloudClient(baseCloudConfig);
		expect(client.defaultOrgId).toBe("org-1");
	});
});

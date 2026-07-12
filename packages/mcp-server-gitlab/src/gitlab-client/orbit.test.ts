// src/gitlab-client/orbit.test.ts

import { afterEach, describe, expect, test } from "bun:test";
import { isOrbitIndexed, OrbitRestClient, OrbitUnavailableError } from "./orbit.js";

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
});

function stubFetch(handler: (url: string, init: RequestInit) => Response): void {
	globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) =>
		handler(String(input), init ?? {})) as typeof fetch;
}

function makeClient() {
	return new OrbitRestClient({
		instanceUrl: "https://gitlab.com",
		personalAccessToken: "pat-123",
		queryPath: "/api/v4/orbit/query",
		schemaPath: "/api/v4/orbit/schema",
		statusPath: "/api/v4/orbit/status",
		timeout: 5000,
	});
}

describe("OrbitRestClient", () => {
	test("getStatus hits /orbit/status with a Bearer token (GET, no /api/v4 doubling)", async () => {
		const seen: { url?: string; auth?: string | null; method?: string } = {};
		stubFetch((url, init) => {
			seen.url = url;
			seen.method = init.method;
			seen.auth = new Headers(init.headers).get("Authorization");
			return new Response(JSON.stringify({ status: "indexed" }), { status: 200 });
		});
		const status = await makeClient().getStatus();
		expect(seen.url).toBe("https://gitlab.com/api/v4/orbit/status");
		expect(seen.method).toBe("GET");
		expect(seen.auth).toBe("Bearer pat-123");
		expect(status.status).toBe("indexed");
	});

	test("query POSTs { query, format: 'raw' } to /orbit/query", async () => {
		let seenBody: unknown;
		let seenMethod: string | undefined;
		stubFetch((_url, init) => {
			seenMethod = init.method;
			seenBody = init.body ? JSON.parse(init.body as string) : undefined;
			return new Response(JSON.stringify({ result: { rows: [] }, row_count: 0 }), { status: 200 });
		});
		await makeClient().query({ query_type: "traversal", node: { id: "p", entity: "Project" } });
		expect(seenMethod).toBe("POST");
		expect(seenBody).toMatchObject({ format: "raw", query: { query_type: "traversal" } });
	});

	test("non-2xx surfaces OrbitUnavailableError with the status code", async () => {
		stubFetch(() => new Response("feature flag off", { status: 404, statusText: "Not Found" }));
		const client = makeClient();
		await expect(client.getStatus()).rejects.toBeInstanceOf(OrbitUnavailableError);
		try {
			await client.getStatus();
		} catch (e) {
			expect((e as OrbitUnavailableError).status).toBe(404);
		}
	});
});

describe("isOrbitIndexed", () => {
	test("true when status is 'indexed'", () => {
		expect(isOrbitIndexed({ status: "indexed" })).toBe(true);
	});
	test("true when both domains are indexed", () => {
		expect(isOrbitIndexed({ domains: { sdlc: { indexed: true }, code: { indexed: true } } })).toBe(true);
	});
	test("false when a domain is still indexing", () => {
		expect(isOrbitIndexed({ status: "indexing", domains: { sdlc: { indexed: true }, code: { indexed: false } } })).toBe(
			false,
		);
	});
});

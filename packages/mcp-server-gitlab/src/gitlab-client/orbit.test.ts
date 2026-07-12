// src/gitlab-client/orbit.test.ts

import { afterEach, describe, expect, test } from "bun:test";
import { isOrbitIndexed, OrbitRestClient, OrbitStatusResponseSchema, OrbitUnavailableError } from "./orbit.js";

// SIO-1077: the REAL gitlab.com Orbit v0.86.0 GET /orbit/status response shape, captured
// live. It has NO top-level `status` and NO `domains` -- the fields the original
// isOrbitIndexed() checked -- so a healthy, fully-indexed Orbit was misread as unavailable.
const LIVE_HEALTHY_STATUS = {
	user: { available: true },
	system: {
		status: "healthy",
		version: "0.86.0",
		components: [
			{ name: "gkg-indexer-sdlc", status: "healthy", replicas: { ready: 8, desired: 8 } },
			{ name: "gkg-indexer-code", status: "healthy", replicas: { ready: 10, desired: 10 } },
			{ name: "gkg-webserver", status: "healthy", replicas: { ready: 3, desired: 3 } },
			{ name: "gkg-dispatcher", status: "healthy", replicas: { ready: 1, desired: 1 } },
			{ name: "nats", status: "healthy", replicas: { ready: 3, desired: 3 } },
		],
	},
};

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

describe("isOrbitIndexed (legacy shape)", () => {
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

describe("isOrbitIndexed (live gitlab.com system/components shape, SIO-1077)", () => {
	test("true for a healthy Orbit with both indexers ready", () => {
		const parsed = OrbitStatusResponseSchema.parse(LIVE_HEALTHY_STATUS);
		expect(isOrbitIndexed(parsed)).toBe(true);
	});

	test("false when the sdlc indexer has zero ready replicas", () => {
		const degraded = {
			...LIVE_HEALTHY_STATUS,
			system: {
				...LIVE_HEALTHY_STATUS.system,
				components: [
					{ name: "gkg-indexer-sdlc", status: "healthy", replicas: { ready: 0, desired: 8 } },
					{ name: "gkg-indexer-code", status: "healthy", replicas: { ready: 10, desired: 10 } },
				],
			},
		};
		expect(isOrbitIndexed(OrbitStatusResponseSchema.parse(degraded))).toBe(false);
	});

	test("false when system.status is not healthy", () => {
		const unhealthy = { ...LIVE_HEALTHY_STATUS, system: { ...LIVE_HEALTHY_STATUS.system, status: "unhealthy" } };
		expect(isOrbitIndexed(OrbitStatusResponseSchema.parse(unhealthy))).toBe(false);
	});

	test("false when an indexer component is absent", () => {
		const missing = {
			...LIVE_HEALTHY_STATUS,
			system: {
				...LIVE_HEALTHY_STATUS.system,
				components: [{ name: "gkg-indexer-code", status: "healthy", replicas: { ready: 10, desired: 10 } }],
			},
		};
		expect(isOrbitIndexed(OrbitStatusResponseSchema.parse(missing))).toBe(false);
	});
});

describe("OrbitStatusResponseSchema (SIO-1077)", () => {
	test("parses the live response without throwing and preserves system.components", () => {
		const parsed = OrbitStatusResponseSchema.parse(LIVE_HEALTHY_STATUS);
		expect(parsed.system?.components).toHaveLength(5);
		expect(parsed.system?.status).toBe("healthy");
	});

	test("still parses the legacy documented shape", () => {
		const parsed = OrbitStatusResponseSchema.parse({ status: "indexed", domains: { sdlc: { indexed: true } } });
		expect(parsed.status).toBe("indexed");
	});
});

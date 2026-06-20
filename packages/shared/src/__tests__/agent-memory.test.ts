// shared/src/__tests__/agent-memory.test.ts
import { afterEach, describe, expect, test } from "bun:test";
import {
	type AgentMemoryConfig,
	createFetchAgentMemoryClient,
	resolveAgentMemoryConfig,
	ServiceUnavailableError,
	SessionAlreadyEndedError,
} from "../agent-memory.ts";

const CONFIG: AgentMemoryConfig = { baseUrl: "http://mem.test", enabled: true };
const REF = { userId: "incident-analyzer", sessionId: "t-1" };

interface FetchCall {
	url: string;
	method: string;
	body: unknown;
}

// Installs a fetch stub that records calls and replies per a status/body map
// keyed by "METHOD /path". Returns the recorded calls.
function stubFetch(replies: Record<string, { status: number; body?: unknown }>): {
	calls: FetchCall[];
	restore: () => void;
} {
	const calls: FetchCall[] = [];
	const original = globalThis.fetch;
	globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input.toString();
		const method = init?.method ?? "GET";
		const path = url.replace("http://mem.test", "");
		const body = init?.body ? JSON.parse(init.body as string) : undefined;
		calls.push({ url, method, body });
		const reply = replies[`${method} ${path}`] ?? { status: 200, body: {} };
		return new Response(reply.body === undefined ? null : JSON.stringify(reply.body), { status: reply.status });
	}) as typeof fetch;
	return { calls, restore: () => (globalThis.fetch = original) };
}

afterEach(() => {
	// Each test restores its own stub; nothing global to clean here.
});

describe("resolveAgentMemoryConfig", () => {
	test("throws when baseUrl is missing (no .default in schema)", () => {
		expect(() => resolveAgentMemoryConfig({} as NodeJS.ProcessEnv)).toThrow();
	});

	test("parses enabled flag and optional ttl", () => {
		const cfg = resolveAgentMemoryConfig({
			AGENT_MEMORY_BASE_URL: "http://mem.test",
			AGENT_MEMORY_ENABLED: "true",
			AGENT_MEMORY_DAILYLOG_TTL_SECONDS: "3600",
		} as unknown as NodeJS.ProcessEnv);
		expect(cfg).toEqual({
			baseUrl: "http://mem.test",
			enabled: true,
			bearerToken: undefined,
			dailyLogTtlSeconds: 3600,
			syncWrites: false,
		});
	});

	test("treats empty bearer token as undefined", () => {
		const cfg = resolveAgentMemoryConfig({
			AGENT_MEMORY_BASE_URL: "http://mem.test",
			AGENT_MEMORY_ENABLED: "0",
			AGENT_MEMORY_BEARER_TOKEN: "",
		} as unknown as NodeJS.ProcessEnv);
		expect(cfg.enabled).toBe(false);
		expect(cfg.bearerToken).toBeUndefined();
	});
});

describe("createFetchAgentMemoryClient", () => {
	test("ensureUser/ensureSession swallow 409 conflict", async () => {
		const { calls, restore } = stubFetch({
			"POST /users": { status: 409, body: { detail: "exists" } },
			"POST /users/incident-analyzer/sessions": { status: 409, body: { detail: "exists" } },
		});
		const client = createFetchAgentMemoryClient(CONFIG);
		await client.ensureUser("incident-analyzer", "incident-analyzer");
		await client.ensureSession("incident-analyzer", "t-1");
		expect(calls).toHaveLength(2); // did not throw
		restore();
	});

	test("ensureUser rethrows non-409 errors", async () => {
		const { restore } = stubFetch({ "POST /users": { status: 500, body: { detail: "boom" } } });
		const client = createFetchAgentMemoryClient(CONFIG);
		await expect(client.ensureUser("u", "u")).rejects.toThrow();
		restore();
	});

	test("addMessages sends TTL + created_at, addFacts sends null TTL; both default async_processing", async () => {
		const { calls, restore } = stubFetch({
			"POST /users/incident-analyzer/sessions/t-1/memory": { status: 200, body: { block_ids: ["b1"] } },
		});
		const client = createFetchAgentMemoryClient(CONFIG);
		await client.addMessages(REF, [{ user_content: "q", assistant_content: "a" }], {
			ttlSeconds: 3600,
			createdAt: "2026-06-17T00:00:00Z",
		});
		await client.addFacts(REF, ["a durable fact"], { createdAt: "2026-06-17T01:00:00Z" });
		expect(calls[0]?.body).toMatchObject({
			messages: [{ user_content: "q" }],
			memory_block_ttl: 3600,
			created_at: "2026-06-17T00:00:00Z",
			async_processing: true,
		});
		expect(calls[1]?.body).toMatchObject({
			facts: ["a durable fact"],
			memory_block_ttl: null,
			created_at: "2026-06-17T01:00:00Z",
			async_processing: true,
		});
		restore();
	});

	test("syncWrites config sends async_processing=false", async () => {
		const { calls, restore } = stubFetch({
			"POST /users/incident-analyzer/sessions/t-1/memory": { status: 200, body: { block_ids: ["b1"] } },
		});
		const client = createFetchAgentMemoryClient({ ...CONFIG, syncWrites: true });
		await client.addFacts(REF, ["f"]);
		expect(calls[0]?.body).toMatchObject({ async_processing: false });
		restore();
	});

	// SIO-991: writes return the service's AddMemoryResponse (block_ids + counts) so the caller
	// can log the created Couchbase block ids.
	test("addFacts returns block_ids + accepted/rejected counts from AddMemoryResponse", async () => {
		const { restore } = stubFetch({
			"POST /users/incident-analyzer/sessions/t-1/memory": {
				status: 201,
				body: { block_ids: ["blk-1", "blk-2"], accepted_count: 2, rejected_count: 0 },
			},
		});
		const client = createFetchAgentMemoryClient(CONFIG);
		const res = await client.addFacts(REF, ["a", "b"]);
		expect(res).toEqual({ blockIds: ["blk-1", "blk-2"], acceptedCount: 2, rejectedCount: 0 });
		restore();
	});

	test("addFacts on empty input returns an empty result without calling the service", async () => {
		const { calls, restore } = stubFetch({});
		const client = createFetchAgentMemoryClient(CONFIG);
		const res = await client.addFacts(REF, []);
		expect(res).toEqual({ blockIds: [], acceptedCount: 0, rejectedCount: 0 });
		expect(calls).toHaveLength(0);
		restore();
	});

	test("addFacts falls back to block_ids length when counts are absent", async () => {
		const { restore } = stubFetch({
			"POST /users/incident-analyzer/sessions/t-1/memory": { status: 201, body: { block_ids: ["b1"] } },
		});
		const client = createFetchAgentMemoryClient(CONFIG);
		const res = await client.addFacts(REF, ["x"]);
		expect(res).toMatchObject({ blockIds: ["b1"], acceptedCount: 1, rejectedCount: 0 });
		restore();
	});

	test("search filters non-ready blocks, returns text + rel_score, and applies minScore", async () => {
		const { calls, restore } = stubFetch({
			"POST /users/incident-analyzer/sessions/t-1/memory/search": {
				status: 200,
				body: {
					count: 4,
					memory_blocks: [
						{ status: "ready", summary: "strong", rel_score: 0.9 },
						{ status: "processing", summary: "should be hidden", rel_score: 0.99 },
						{ status: "ready", fact: "weak", rel_score: 0.1 },
						{ status: "ready", fact: "mid", rel_score: 0.5 },
					],
				},
			},
		});
		const client = createFetchAgentMemoryClient(CONFIG);
		const hits = await client.searchMemory(REF, "kafka lag", { allSessions: true, relevantK: 5, minScore: 0.4 });
		expect(hits).toMatchObject([
			{ text: "strong", score: 0.9 },
			{ text: "mid", score: 0.5 },
		]);
		expect(calls[0]?.body).toMatchObject({ query: "kafka lag", filters: { session_ids: "all", relevant_k: 5 } });
		restore();
	});

	// SIO-991: a hit surfaces the Couchbase document coordinates (block_id/user_id/session_id) so a
	// recall can be cross-referenced against the exact memory-block document in Capella.
	test("searchMemory surfaces block_id / user_id / session_id per hit", async () => {
		const { restore } = stubFetch({
			"POST /users/incident-analyzer/sessions/t-1/memory/search": {
				status: 200,
				body: {
					count: 1,
					memory_blocks: [
						{
							status: "ready",
							summary: "a change",
							rel_score: 0.7,
							block_id: "blk-42",
							user_id: "elastic-iac",
							session_id: "thread-xyz",
						},
					],
				},
			},
		});
		const client = createFetchAgentMemoryClient(CONFIG);
		const hits = await client.searchMemory(REF, "change");
		expect(hits[0]).toMatchObject({
			text: "a change",
			blockId: "blk-42",
			userId: "elastic-iac",
			sessionId: "thread-xyz",
		});
		restore();
	});

	// SIO-959: annotation-filtered search -- the filter is sent, and each hit carries
	// back its annotations so a structured (not prose) lookup can read pipeline_id etc.
	test("searchMemory sends an annotations filter and returns block annotations per hit", async () => {
		const { calls, restore } = stubFetch({
			"POST /users/elastic-iac/sessions/t-iac/memory/search": {
				status: 200,
				body: {
					count: 1,
					memory_blocks: [
						{
							status: "ready",
							fact: "Fleet agents on us-cld upgrade DISPATCHED to 9.4.2.",
							rel_score: 0.8,
							annotations: {
								kind: "fleet-upgrade-dispatched",
								deployment: "us-cld",
								version: "9.4.2",
								pipeline_id: "2614422047",
							},
						},
					],
				},
			},
		});
		const client = createFetchAgentMemoryClient(CONFIG);
		const ref = { userId: "elastic-iac", sessionId: "t-iac" };
		const hits = await client.searchMemory(ref, "in-flight fleet upgrades", {
			allSessions: true,
			annotations: { kind: "fleet-upgrade-dispatched" },
		});
		// filter reached the request body
		expect(calls[0]?.body).toMatchObject({
			filters: { session_ids: "all", annotations: { kind: "fleet-upgrade-dispatched" } },
		});
		// annotations come back on the hit
		expect(hits).toHaveLength(1);
		expect(hits[0]?.annotations).toMatchObject({ deployment: "us-cld", pipeline_id: "2614422047" });
		restore();
	});

	test("sets Authorization header only when a bearer token is configured", async () => {
		const original = globalThis.fetch;
		const captured: { auth: string | null } = { auth: null };
		globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
			captured.auth = new Headers(init?.headers).get("Authorization");
			return new Response("{}", { status: 200 });
		}) as typeof fetch;
		const client = createFetchAgentMemoryClient({ ...CONFIG, bearerToken: "jwt-123" });
		await client.endSession(REF);
		expect(captured.auth).toBe("Bearer jwt-123");
		globalThis.fetch = original;
	});

	test("endSession POSTs to /sessions/{id}/end, not /memory/end (SIO-952)", async () => {
		const { calls, restore } = stubFetch({});
		const client = createFetchAgentMemoryClient(CONFIG);
		await client.endSession(REF);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.method).toBe("POST");
		expect(calls[0]?.url).toBe("http://mem.test/users/incident-analyzer/sessions/t-1/end");
		restore();
	});

	test("updateSession PUTs annotations + metadata to the session (SIO-952)", async () => {
		const { calls, restore } = stubFetch({});
		const client = createFetchAgentMemoryClient(CONFIG);
		await client.updateSession(REF, { annotations: { outcome: "mr-opened" } });
		expect(calls[0]?.method).toBe("PUT");
		expect(calls[0]?.url).toBe("http://mem.test/users/incident-analyzer/sessions/t-1");
		expect(calls[0]?.body).toMatchObject({ annotations: { outcome: "mr-opened" }, metadata: null });
		restore();
	});

	test("ensureUser/ensureSession/writes carry annotations + metadata when provided (SIO-952)", async () => {
		const { calls, restore } = stubFetch({});
		const client = createFetchAgentMemoryClient(CONFIG);
		await client.ensureUser("elastic-iac", "elastic-iac", { agent: "elastic-iac", role: "iac-maker" });
		await client.ensureSession("elastic-iac", "t-1", {
			annotations: { agent: "elastic-iac", datasources: "elastic-iac" },
		});
		await client.addFacts(REF, ["f"], { annotations: { intent: "fleet-upgrade", kind: "key-decision" } });
		expect(calls[0]?.body).toMatchObject({ metadata: { agent: "elastic-iac", role: "iac-maker" } });
		expect(calls[1]?.body).toMatchObject({
			annotations: { agent: "elastic-iac", datasources: "elastic-iac" },
			metadata: null,
		});
		expect(calls[2]?.body).toMatchObject({ annotations: { intent: "fleet-upgrade", kind: "key-decision" } });
		restore();
	});

	test("400 SESSION_ALREADY_ENDED throws SessionAlreadyEndedError (SIO-956)", async () => {
		const { restore } = stubFetch({
			"POST /users/incident-analyzer/sessions/t-1/end": {
				status: 400,
				body: { error: "SESSION_ALREADY_ENDED", message: "already ended" },
			},
		});
		const client = createFetchAgentMemoryClient(CONFIG);
		let caught: unknown;
		try {
			await client.endSession(REF);
		} catch (e) {
			caught = e;
		}
		expect(caught).toBeInstanceOf(SessionAlreadyEndedError);
		restore();
	});

	test("503 throws ServiceUnavailableError carrying retry_after_seconds (from body)", async () => {
		const { restore } = stubFetch({
			"POST /users/incident-analyzer/sessions/t-1/memory": { status: 503, body: { retry_after_seconds: 12 } },
		});
		const client = createFetchAgentMemoryClient(CONFIG);
		let caught: unknown;
		try {
			await client.addFacts(REF, ["f"]);
		} catch (e) {
			caught = e;
		}
		expect(caught).toBeInstanceOf(ServiceUnavailableError);
		expect((caught as ServiceUnavailableError).retryAfterSeconds).toBe(12);
		restore();
	});

	test("checkHealth returns ok for a healthy status and never throws on failure", async () => {
		const { restore } = stubFetch({ "GET /health": { status: 200, body: { status: "ok" } } });
		const client = createFetchAgentMemoryClient(CONFIG);
		expect(await client.checkHealth()).toMatchObject({ ok: true, status: "ok" });
		restore();

		const { restore: restore2 } = stubFetch({ "GET /health": { status: 500, body: { detail: "down" } } });
		const client2 = createFetchAgentMemoryClient(CONFIG);
		const health = await client2.checkHealth();
		expect(health.ok).toBe(false);
		restore2();
	});
});

describe("resolveAgentMemoryConfig syncWrites", () => {
	test("parses AGENT_MEMORY_SYNC_WRITES", () => {
		const cfg = resolveAgentMemoryConfig({
			AGENT_MEMORY_BASE_URL: "http://mem.test",
			AGENT_MEMORY_ENABLED: "true",
			AGENT_MEMORY_SYNC_WRITES: "true",
		} as unknown as NodeJS.ProcessEnv);
		expect(cfg.syncWrites).toBe(true);
	});
});

// shared/src/__tests__/agent-memory.test.ts
import { afterEach, describe, expect, test } from "bun:test";
import {
	type AgentMemoryConfig,
	createFetchAgentMemoryClient,
	resolveAgentMemoryConfig,
	ServiceUnavailableError,
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
		await client.addMessages(REF, [{ user_content: "q", assistant_content: "a" }], { ttlSeconds: 3600, createdAt: "2026-06-17T00:00:00Z" });
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
		expect(hits).toEqual([
			{ text: "strong", score: 0.9 },
			{ text: "mid", score: 0.5 },
		]);
		expect(calls[0]?.body).toMatchObject({ query: "kafka lag", filters: { session_ids: "all", relevant_k: 5 } });
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

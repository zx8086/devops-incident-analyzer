// shared/src/agent-memory.ts
//
// SIO-938: typed fetch client for the Couchbase Agent Memory REST service
// (see migrate/api-docs/). Backs the gitagent live-memory tier when
// LIVE_MEMORY_BACKEND=agent-memory. Mirrors the memory-pr github-client shape:
// a narrow interface, a fetch implementation, and an injection seam for tests.
//
// The interface deliberately exposes only the operations the agent lifecycle
// needs: idempotent user/session creation, fact/message writes, semantic
// recall, session end, and a readiness probe. There is no delete/list/update —
// memory pruning is the service's TTL concern, not the agent's.
//
// Embeddings: the service generates the vector embedding + summary for each
// block (there is no client-supplied vector field). Search sends a natural
// query and the service runs FTS KNN over those embeddings. Blocks only enter
// the index once status === "ready"; with async_processing=false a write blocks
// until ready, so a just-written block is immediately searchable.

import { z } from "zod";

export const AgentMemoryConfigSchema = z.object({
	baseUrl: z.string().url(),
	enabled: z.boolean(),
	bearerToken: z.string().optional(),
	dailyLogTtlSeconds: z.number().int().positive().optional(),
	// SIO-938 follow-up: when true, writes use async_processing=false so blocks
	// reach "ready" (embedded + searchable) before the call returns.
	syncWrites: z.boolean().optional(),
});
export type AgentMemoryConfig = z.infer<typeof AgentMemoryConfigSchema>;

export interface AgentMemoryUserRef {
	userId: string;
	sessionId: string;
}

export interface ChatMessageBlock {
	user_content: string;
	assistant_content: string;
}

// Per-write options. createdAt feeds the service's timestamp-based conflict
// resolution (the original data-creation time, distinct from ingestion time).
export interface AddOptions {
	ttlSeconds?: number;
	createdAt?: string;
}

// A semantic-search hit: the recalled text plus the service's relevance score
// (rel_score from the FTS KNN ranking). Higher is more relevant; undefined when
// the result was filter-only (no query).
export interface MemoryHit {
	text: string;
	score?: number;
}

export interface AgentMemoryHealth {
	ok: boolean;
	status?: string;
	detail?: string;
}

export interface AgentMemoryClient {
	// create-if-missing; swallows 409 conflict so callers can call freely.
	ensureUser(userId: string, name: string): Promise<void>;
	ensureSession(userId: string, sessionId: string): Promise<void>;
	addFacts(ref: AgentMemoryUserRef, facts: string[], opts?: AddOptions): Promise<void>;
	addMessages(ref: AgentMemoryUserRef, messages: ChatMessageBlock[], opts?: AddOptions): Promise<void>;
	// Semantic search; returns ready blocks ranked by rel_score (processing/failed
	// excluded). minScore drops weak matches; relevantK caps the KNN candidate pool.
	searchMemory(
		ref: AgentMemoryUserRef,
		query: string,
		opts?: { allSessions?: boolean; relevantK?: number; minScore?: number },
	): Promise<MemoryHit[]>;
	endSession(ref: AgentMemoryUserRef): Promise<void>;
	// Readiness probe (GET /health). Never throws; returns ok:false on any failure.
	checkHealth(): Promise<AgentMemoryHealth>;
}

// Minimal response shapes (subset of migrate/api-docs/types.ts).
interface MemoryBlockShape {
	fact?: string | null;
	summary?: string | null;
	status?: string;
	rel_score?: number | null;
}
interface MemoryResponseShape {
	memory_blocks: MemoryBlockShape[];
	count: number;
}

class ConflictError extends Error {}

// Raised on 503 (extraction queue saturated); carries the service's retry hint.
class ServiceUnavailableError extends Error {
	constructor(
		message: string,
		readonly retryAfterSeconds?: number,
	) {
		super(message);
	}
}

async function amFetch<T>(config: AgentMemoryConfig, method: string, path: string, body?: unknown): Promise<T> {
	const headers: Record<string, string> = { "Content-Type": "application/json" };
	if (config.bearerToken) headers.Authorization = `Bearer ${config.bearerToken}`;
	const res = await fetch(`${config.baseUrl}${path}`, {
		method,
		headers,
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	if (!res.ok) {
		const text = await res.text().catch(() => "");
		if (res.status === 409) throw new ConflictError(text);
		if (res.status === 503) {
			// retry_after_seconds may arrive in the body (preferred) or the header.
			let retry: number | undefined;
			try {
				const parsed = JSON.parse(text) as { retry_after_seconds?: number };
				if (typeof parsed.retry_after_seconds === "number") retry = parsed.retry_after_seconds;
			} catch {
				// non-JSON body; fall through to the header
			}
			if (retry === undefined) {
				const header = res.headers.get("retry-after");
				if (header) retry = Number(header);
			}
			throw new ServiceUnavailableError(`AgentMemory ${method} ${path} unavailable: ${text}`.trim(), retry);
		}
		throw new Error(`AgentMemory ${method} ${path} failed: ${res.status} ${res.statusText} ${text}`.trim());
	}
	if (res.status === 204) return undefined as T;
	return (await res.json().catch(() => undefined)) as T;
}

export function createFetchAgentMemoryClient(config: AgentMemoryConfig): AgentMemoryClient {
	const enc = encodeURIComponent;
	// async_processing=false (sync) only when explicitly enabled; default async.
	const asyncProcessing = !config.syncWrites;
	const memoryPath = (ref: AgentMemoryUserRef) => `/users/${enc(ref.userId)}/sessions/${enc(ref.sessionId)}/memory`;

	return {
		async ensureUser(userId, name) {
			try {
				await amFetch(config, "POST", "/users", { user_id: userId, name });
			} catch (error) {
				if (!(error instanceof ConflictError)) throw error;
			}
		},

		async ensureSession(userId, sessionId) {
			try {
				await amFetch(config, "POST", `/users/${enc(userId)}/sessions`, { session_id: sessionId });
			} catch (error) {
				if (!(error instanceof ConflictError)) throw error;
			}
		},

		async addFacts(ref, facts, opts) {
			if (facts.length === 0) return;
			await amFetch(config, "POST", memoryPath(ref), {
				facts,
				memory_block_ttl: opts?.ttlSeconds ?? null,
				created_at: opts?.createdAt ?? null,
				async_processing: asyncProcessing,
			});
		},

		async addMessages(ref, messages, opts) {
			if (messages.length === 0) return;
			await amFetch(config, "POST", memoryPath(ref), {
				messages,
				memory_block_ttl: opts?.ttlSeconds ?? null,
				created_at: opts?.createdAt ?? null,
				async_processing: asyncProcessing,
			});
		},

		async searchMemory(ref, query, opts) {
			const res = await amFetch<MemoryResponseShape>(config, "POST", `${memoryPath(ref)}/search`, {
				query,
				filters: {
					session_ids: opts?.allSessions ? "all" : undefined,
					relevant_k: opts?.relevantK ?? null,
				},
			});
			const minScore = opts?.minScore;
			return (res?.memory_blocks ?? [])
				.filter((b) => b.status === undefined || b.status === "ready")
				.map((b) => ({ text: b.summary ?? b.fact ?? "", score: b.rel_score ?? undefined }))
				.filter((h) => h.text.length > 0 && (minScore === undefined || (h.score ?? 0) >= minScore));
		},

		async endSession(ref) {
			await amFetch(config, "POST", `${memoryPath(ref)}/end`);
		},

		async checkHealth() {
			try {
				const res = await amFetch<{ status?: string }>(config, "GET", "/health");
				const status = res?.status;
				return { ok: status === undefined || status === "ok" || status === "healthy", status };
			} catch (error) {
				return { ok: false, detail: error instanceof Error ? error.message : String(error) };
			}
		},
	};
}

export { ServiceUnavailableError };

// Builds the config from AGENT_MEMORY_* env vars then validates. No .default()
// in the schema (project rule); defaults applied here, same as resolveMemoryPrConfig.
export function resolveAgentMemoryConfig(env: NodeJS.ProcessEnv = process.env): AgentMemoryConfig {
	const flag = env.AGENT_MEMORY_ENABLED;
	const ttlRaw = env.AGENT_MEMORY_DAILYLOG_TTL_SECONDS;
	const ttl = ttlRaw && ttlRaw !== "" ? Number(ttlRaw) : undefined;
	const sync = env.AGENT_MEMORY_SYNC_WRITES;
	return AgentMemoryConfigSchema.parse({
		baseUrl: env.AGENT_MEMORY_BASE_URL,
		enabled: flag === "true" || flag === "1",
		bearerToken:
			env.AGENT_MEMORY_BEARER_TOKEN && env.AGENT_MEMORY_BEARER_TOKEN !== "" ? env.AGENT_MEMORY_BEARER_TOKEN : undefined,
		dailyLogTtlSeconds: ttl,
		syncWrites: sync === "true" || sync === "1",
	});
}

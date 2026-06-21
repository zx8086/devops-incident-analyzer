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

// String-valued key/value labels for annotation-based filtering and access
// control (the service types annotations/metadata as free-form objects; we
// constrain to flat string maps so they stay queryable and PII-safe).
export type AnnotationMap = Record<string, string>;

// Per-write options. createdAt feeds the service's timestamp-based conflict
// resolution (the original data-creation time, distinct from ingestion time).
// SIO-952: annotations label the block (e.g. { intent, kind }) for recall.
export interface AddOptions {
	ttlSeconds?: number;
	createdAt?: string;
	annotations?: AnnotationMap;
}

// A semantic-search hit: the recalled text plus the service's relevance score
// (rel_score from the FTS KNN ranking). Higher is more relevant; undefined when
// the result was filter-only (no query).
// SIO-959: annotations are returned so callers can read structured fields (e.g. a
// dispatched fleet upgrade's pipeline_id) instead of parsing them out of the text.
// SIO-991: block_id/user_id/session_id are surfaced so a recall can be cross-
// referenced against the exact Couchbase memory-block document (the service's
// MemoryBlock carries all three).
export interface MemoryHit {
	text: string;
	score?: number;
	annotations?: AnnotationMap;
	blockId?: string;
	userId?: string;
	sessionId?: string;
}

// SIO-991: the service's AddMemoryResponse, surfaced so the writer/backend can log the
// created block_ids (the Couchbase document keys) alongside the accepted/rejected counts.
// block_ids is [] when the backend is the file default or the write produced no blocks.
export interface AddMemoryResult {
	blockIds: string[];
	acceptedCount: number;
	rejectedCount: number;
}

export interface AgentMemoryHealth {
	ok: boolean;
	status?: string;
	detail?: string;
}

export interface AgentMemoryClient {
	// create-if-missing; swallows 409 conflict so callers can call freely.
	// SIO-952: metadata stamps which agent owns the user (e.g. { agent, role }).
	ensureUser(userId: string, name: string, metadata?: AnnotationMap): Promise<void>;
	// SIO-952: annotations/metadata label the conversation (e.g. { agent, datasources }).
	ensureSession(
		userId: string,
		sessionId: string,
		opts?: { annotations?: AnnotationMap; metadata?: AnnotationMap },
	): Promise<void>;
	// SIO-991: return the service's AddMemoryResponse (block_ids + counts) so callers can log
	// the created Couchbase block ids. Empty result ({ blockIds: [], accepted: 0, rejected: 0 })
	// for an empty input.
	addFacts(ref: AgentMemoryUserRef, facts: string[], opts?: AddOptions): Promise<AddMemoryResult>;
	addMessages(ref: AgentMemoryUserRef, messages: ChatMessageBlock[], opts?: AddOptions): Promise<AddMemoryResult>;
	// Semantic search; returns ready blocks ranked by rel_score (processing/failed
	// excluded). minScore drops weak matches; relevantK caps the KNN candidate pool.
	// SIO-959: `annotations` adds a structured filter (FilterOptions.annotations) so
	// callers can retrieve, e.g., only in-flight fleet upgrades. `query` may be empty
	// for a pure filter-driven lookup.
	searchMemory(
		ref: AgentMemoryUserRef,
		query: string,
		opts?: { allSessions?: boolean; relevantK?: number; minScore?: number; annotations?: AnnotationMap },
	): Promise<MemoryHit[]>;
	// SIO-952: stamp final annotations/metadata on the session (e.g. { outcome }).
	updateSession(
		ref: AgentMemoryUserRef,
		patch: { annotations?: AnnotationMap; metadata?: AnnotationMap },
	): Promise<void>;
	endSession(ref: AgentMemoryUserRef): Promise<void>;
	// Readiness probe (GET /health). Never throws; returns ok:false on any failure.
	checkHealth(): Promise<AgentMemoryHealth>;
}

// Minimal response shapes (subset of the AgentMemory OpenAPI schemas).
// SIO-991: block_id/user_id/session_id are part of the service's MemoryBlock and let a
// recall point at the exact Couchbase document.
interface MemoryBlockShape {
	block_id?: string | null;
	user_id?: string | null;
	session_id?: string | null;
	fact?: string | null;
	summary?: string | null;
	status?: string;
	rel_score?: number | null;
	annotations?: AnnotationMap | null;
}
interface MemoryResponseShape {
	memory_blocks: MemoryBlockShape[];
	count: number;
}
// SIO-991: AddMemoryResponse (POST .../memory) — the created block ids + accept/reject counts.
interface AddMemoryResponseShape {
	block_ids?: string[] | null;
	accepted_count?: number | null;
	rejected_count?: number | null;
}

class ConflictError extends Error {}

// SIO-956: raised when an end/write targets a session the service has already
// ended (400 SESSION_ALREADY_ENDED). Benign for teardown (idempotent end) — the
// caller treats it as success rather than a dropped-write/failed-end error.
export class SessionAlreadyEndedError extends Error {}

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
		// SIO-956: the service returns 400 {"error":"SESSION_ALREADY_ENDED"} on an
		// end/write to an already-ended session. Surface a typed error so teardown
		// can treat it as idempotent success instead of a noisy failure.
		if (res.status === 400 && text.includes("SESSION_ALREADY_ENDED")) {
			throw new SessionAlreadyEndedError(text);
		}
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

// SIO-991: normalize the service's AddMemoryResponse into AddMemoryResult. A null/absent
// block_ids (older service or non-JSON 201 body) falls back to acceptedCount = input length.
function toAddResult(res: AddMemoryResponseShape | undefined, inputCount: number): AddMemoryResult {
	const blockIds = res?.block_ids ?? [];
	return {
		blockIds,
		acceptedCount: res?.accepted_count ?? blockIds.length ?? inputCount,
		rejectedCount: res?.rejected_count ?? 0,
	};
}

export function createFetchAgentMemoryClient(config: AgentMemoryConfig): AgentMemoryClient {
	const enc = encodeURIComponent;
	// async_processing=false (sync) only when explicitly enabled; default async.
	const asyncProcessing = !config.syncWrites;
	const memoryPath = (ref: AgentMemoryUserRef) => `/users/${enc(ref.userId)}/sessions/${enc(ref.sessionId)}/memory`;

	return {
		async ensureUser(userId, name, metadata) {
			try {
				await amFetch(config, "POST", "/users", { user_id: userId, name, metadata: metadata ?? null });
			} catch (error) {
				if (!(error instanceof ConflictError)) throw error;
			}
		},

		async ensureSession(userId, sessionId, opts) {
			try {
				await amFetch(config, "POST", `/users/${enc(userId)}/sessions`, {
					session_id: sessionId,
					annotations: opts?.annotations ?? null,
					metadata: opts?.metadata ?? null,
				});
			} catch (error) {
				if (!(error instanceof ConflictError)) throw error;
			}
		},

		async addFacts(ref, facts, opts) {
			if (facts.length === 0) return { blockIds: [], acceptedCount: 0, rejectedCount: 0 };
			const res = await amFetch<AddMemoryResponseShape>(config, "POST", memoryPath(ref), {
				facts,
				annotations: opts?.annotations ?? null,
				memory_block_ttl: opts?.ttlSeconds ?? null,
				created_at: opts?.createdAt ?? null,
				async_processing: asyncProcessing,
			});
			return toAddResult(res, facts.length);
		},

		async addMessages(ref, messages, opts) {
			if (messages.length === 0) return { blockIds: [], acceptedCount: 0, rejectedCount: 0 };
			const res = await amFetch<AddMemoryResponseShape>(config, "POST", memoryPath(ref), {
				messages,
				annotations: opts?.annotations ?? null,
				memory_block_ttl: opts?.ttlSeconds ?? null,
				created_at: opts?.createdAt ?? null,
				async_processing: asyncProcessing,
			});
			return toAddResult(res, messages.length);
		},

		async searchMemory(ref, query, opts) {
			// SIO-998: a non-empty query selects SEMANTIC mode (FTS-KNN ranked, top-relevant_k); an empty
			// query selects DETERMINISTIC mode -- send `filters` ALONE, omitting both `query` and
			// `relevant_k`, so the annotation filter is the authoritative WHERE clause with no top-k
			// truncation. Per the service's OpenAPI: only the time bounds pre-filter the KNN candidate
			// pool; `annotations` post-filters the ranked top-k, so an identifier-keyed lookup under a
			// query string can be truncated to 0 before the filter applies. See
			// docs/architecture/agent-memory.md "Retrieval: TWO modes".
			const deterministic = query.length === 0;
			const res = await amFetch<MemoryResponseShape>(config, "POST", `${memoryPath(ref)}/search`, {
				...(deterministic ? {} : { query }),
				filters: {
					session_ids: opts?.allSessions ? "all" : undefined,
					// In deterministic mode relevant_k must be absent (it implies/enables the ranked path).
					...(deterministic ? {} : { relevant_k: opts?.relevantK ?? null }),
					// SIO-959: structured annotation filter (e.g. { kind: "fleet-upgrade-dispatched" }).
					annotations: opts?.annotations ?? undefined,
				},
			});
			const minScore = opts?.minScore;
			return (res?.memory_blocks ?? [])
				.filter((b) => b.status === undefined || b.status === "ready")
				.map((b) => ({
					text: b.summary ?? b.fact ?? "",
					score: b.rel_score ?? undefined,
					// SIO-959: surface annotations so callers read structured fields (pipeline_id, ...).
					annotations: b.annotations ?? undefined,
					// SIO-991: the Couchbase document coordinates for cross-referencing a recall.
					blockId: b.block_id ?? undefined,
					userId: b.user_id ?? undefined,
					sessionId: b.session_id ?? undefined,
				}))
				.filter((h) => h.text.length > 0 && (minScore === undefined || (h.score ?? 0) >= minScore));
		},

		async updateSession(ref, patch) {
			await amFetch(config, "PUT", `/users/${enc(ref.userId)}/sessions/${enc(ref.sessionId)}`, {
				annotations: patch.annotations ?? null,
				metadata: patch.metadata ?? null,
			});
		},

		async endSession(ref) {
			// SIO-952: the end endpoint is on the session, not nested under /memory.
			await amFetch(config, "POST", `/users/${enc(ref.userId)}/sessions/${enc(ref.sessionId)}/end`);
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

// shared/src/agent-memory.ts
//
// SIO-938: typed fetch client for the Couchbase Agent Memory REST service
// (see migrate/api-docs/). Backs the gitagent live-memory tier when
// LIVE_MEMORY_BACKEND=agent-memory. Mirrors the memory-pr github-client shape:
// a narrow interface, a fetch implementation, and an injection seam for tests.
//
// The interface deliberately exposes only the operations the agent lifecycle
// needs: idempotent user/session creation, fact/message writes, semantic
// recall, and session end. There is no delete/list — memory pruning is the
// service's TTL concern, not the agent's.

import { z } from "zod";

export const AgentMemoryConfigSchema = z.object({
	baseUrl: z.string().url(),
	enabled: z.boolean(),
	bearerToken: z.string().optional(),
	dailyLogTtlSeconds: z.number().int().positive().optional(),
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

export interface AgentMemoryClient {
	// create-if-missing; swallows 409 conflict so callers can call freely.
	ensureUser(userId: string, name: string): Promise<void>;
	ensureSession(userId: string, sessionId: string): Promise<void>;
	addFacts(ref: AgentMemoryUserRef, facts: string[], ttlSeconds?: number): Promise<void>;
	addMessages(ref: AgentMemoryUserRef, messages: ChatMessageBlock[], ttlSeconds?: number): Promise<void>;
	// Returns summary ?? fact strings of blocks that have reached status "ready"
	// (only ready blocks are searchable; processing/failed are filtered out).
	searchMemory(
		ref: AgentMemoryUserRef,
		query: string,
		opts?: { allSessions?: boolean; relevantK?: number },
	): Promise<string[]>;
	endSession(ref: AgentMemoryUserRef): Promise<void>;
}

// Minimal response shapes (subset of migrate/api-docs/types.ts).
interface MemoryBlockShape {
	fact?: string | null;
	summary?: string | null;
	status?: string;
}
interface MemoryResponseShape {
	memory_blocks: MemoryBlockShape[];
	count: number;
}

class ConflictError extends Error {}

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
		throw new Error(`AgentMemory ${method} ${path} failed: ${res.status} ${res.statusText} ${text}`.trim());
	}
	// Some endpoints (end session) return no JSON body; tolerate that.
	if (res.status === 204) return undefined as T;
	return (await res.json().catch(() => undefined)) as T;
}

export function createFetchAgentMemoryClient(config: AgentMemoryConfig): AgentMemoryClient {
	const enc = encodeURIComponent;
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

		async addFacts(ref, facts, ttlSeconds) {
			if (facts.length === 0) return;
			await amFetch(config, "POST", `/users/${enc(ref.userId)}/sessions/${enc(ref.sessionId)}/memory`, {
				facts,
				memory_block_ttl: ttlSeconds ?? null,
			});
		},

		async addMessages(ref, messages, ttlSeconds) {
			if (messages.length === 0) return;
			await amFetch(config, "POST", `/users/${enc(ref.userId)}/sessions/${enc(ref.sessionId)}/memory`, {
				messages,
				memory_block_ttl: ttlSeconds ?? null,
			});
		},

		async searchMemory(ref, query, opts) {
			const res = await amFetch<MemoryResponseShape>(
				config,
				"POST",
				`/users/${enc(ref.userId)}/sessions/${enc(ref.sessionId)}/memory/search`,
				{
					query,
					filters: {
						session_ids: opts?.allSessions ? "all" : undefined,
						relevant_k: opts?.relevantK ?? null,
					},
				},
			);
			const blocks = res?.memory_blocks ?? [];
			return blocks
				.filter((b) => b.status === undefined || b.status === "ready")
				.map((b) => b.summary ?? b.fact ?? "")
				.filter((s) => s.length > 0);
		},

		async endSession(ref) {
			await amFetch(config, "POST", `/users/${enc(ref.userId)}/sessions/${enc(ref.sessionId)}/end`);
		},
	};
}

// Builds the config from AGENT_MEMORY_* env vars then validates. No .default()
// in the schema (project rule); defaults applied here, same as resolveMemoryPrConfig.
export function resolveAgentMemoryConfig(env: NodeJS.ProcessEnv = process.env): AgentMemoryConfig {
	const flag = env.AGENT_MEMORY_ENABLED;
	const ttlRaw = env.AGENT_MEMORY_DAILYLOG_TTL_SECONDS;
	const ttl = ttlRaw && ttlRaw !== "" ? Number(ttlRaw) : undefined;
	return AgentMemoryConfigSchema.parse({
		baseUrl: env.AGENT_MEMORY_BASE_URL,
		enabled: flag === "true" || flag === "1",
		bearerToken:
			env.AGENT_MEMORY_BEARER_TOKEN && env.AGENT_MEMORY_BEARER_TOKEN !== "" ? env.AGENT_MEMORY_BEARER_TOKEN : undefined,
		dailyLogTtlSeconds: ttl,
	});
}

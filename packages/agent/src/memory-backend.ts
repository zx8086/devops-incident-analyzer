// agent/src/memory-backend.ts
//
// SIO-938: the Couchbase Agent Memory backend for the live-memory tier. Selected
// by LIVE_MEMORY_BACKEND (default "file"). Owns the async-to-sync bridge: the
// synchronous writer (memory-writer.ts) enqueues redacted blocks and returns
// immediately; the queue drains at the async lifecycle teardown seam (and when
// it grows past a threshold). This keeps the writer's sync signatures intact so
// terminal graph nodes (follow-up-generator, teardownIac) are untouched.

import { getLogger } from "@devops-agent/observability";
import {
	type AgentMemoryClient,
	type AgentMemoryUserRef,
	type ChatMessageBlock,
	createFetchAgentMemoryClient,
	resolveAgentMemoryConfig,
	ServiceUnavailableError,
} from "@devops-agent/shared";

const logger = getLogger("agent:memory-backend");

export type LiveMemoryBackend = "file" | "agent-memory";

export function selectedBackend(): LiveMemoryBackend {
	return process.env.LIVE_MEMORY_BACKEND === "agent-memory" ? "agent-memory" : "file";
}

// Agent identity -> Agent Memory user_id. One user per agent (SIO-938 decision 3).
export function resolveUserId(agentName: string): string {
	return agentName === "elastic-iac" ? "elastic-iac" : "incident-analyzer";
}

// Short TTL (seconds) for dailylog breadcrumb messages, read defensively from
// env. Returns undefined (no decay) when unset/invalid — the writer must be able
// to enqueue even when the full AgentMemoryConfig (which requires baseUrl) is
// incomplete, so this never parses the whole schema.
export function dailyLogTtlSeconds(): number | undefined {
	const raw = process.env.AGENT_MEMORY_DAILYLOG_TTL_SECONDS;
	if (!raw) return undefined;
	const n = Number(raw);
	return Number.isInteger(n) && n > 0 ? n : undefined;
}

// Whether writes block until the embedding is ready (async_processing=false),
// so a just-written block is immediately searchable. Defensive env read.
export function syncWritesEnabled(): boolean {
	const v = process.env.AGENT_MEMORY_SYNC_WRITES;
	return v === "true" || v === "1";
}

// Injectable client (mirrors memory-pr's options.client ?? createFetch... seam).
// Tests call __setAgentMemoryClient(fake) so no network is touched.
let injectedClient: AgentMemoryClient | null = null;
export function __setAgentMemoryClient(c: AgentMemoryClient | null): void {
	injectedClient = c;
}

let cachedClient: AgentMemoryClient | null = null;
function client(): AgentMemoryClient {
	if (injectedClient) return injectedClient;
	if (!cachedClient) cachedClient = createFetchAgentMemoryClient(resolveAgentMemoryConfig());
	return cachedClient;
}

// The active session ref. Set by the lifecycle bootstrap (agentName + threadId);
// enqueues from the writer attach to it. Until set, enqueues queue with no ref
// and are dropped at flush time with a warning (writer ran outside a session).
let activeRef: AgentMemoryUserRef | null = null;
let activeAgentName = "incident-analyzer";
export function setActiveMemorySession(agentName: string, threadId: string): void {
	activeAgentName = agentName;
	activeRef = { userId: resolveUserId(agentName), sessionId: threadId };
}
export function clearActiveMemorySession(): void {
	activeRef = null;
}

type QueuedWrite =
	| { kind: "fact"; text: string; createdAt: string }
	| { kind: "message"; message: ChatMessageBlock; ttlSeconds?: number; createdAt: string };
const queue: QueuedWrite[] = [];

// Drain when the queue grows large so a long session does not accumulate
// unboundedly; failures are swallowed (best-effort, never block the agent).
const FLUSH_THRESHOLD = 25;

export function enqueueFact(text: string, createdAt: string): void {
	queue.push({ kind: "fact", text, createdAt });
	maybeFlush();
}

export function enqueueMessage(message: ChatMessageBlock, createdAt: string, ttlSeconds?: number): void {
	queue.push({ kind: "message", message, ttlSeconds, createdAt });
	maybeFlush();
}

export function pendingWriteCount(): number {
	return queue.length;
}

// Test-only: drop any queued writes without sending. Prevents cross-test residue
// in the process-global queue (Bun runs a package's test files in one process).
export function __resetMemoryQueue(): void {
	queue.length = 0;
}

function maybeFlush(): void {
	if (queue.length >= FLUSH_THRESHOLD) {
		void flushAgentMemory().catch(() => {
			// flushAgentMemory already logs; swallow here so enqueue stays sync/safe.
		});
	}
}

// Drains the queue to the service. Ensures the user + session exist first
// (idempotent, 409-tolerant). Best-effort: on error the batch is logged. On a
// 503 (extraction queue saturated) the batch is REQUEUED rather than dropped so
// the next flush (or session teardown) retries it; live memory must never block
// or fail a session, but transient saturation should not silently lose writes.
export async function flushAgentMemory(): Promise<void> {
	if (queue.length === 0) return;
	const ref = activeRef;
	const batch = queue.splice(0, queue.length);
	if (!ref) {
		logger.warn({ dropped: batch.length }, "agent-memory flush with no active session; dropping writes");
		return;
	}
	try {
		const c = client();
		await c.ensureUser(ref.userId, activeAgentName);
		await c.ensureSession(ref.userId, ref.sessionId);
		// Per-block createdAt feeds the service's conflict resolution, so send each
		// block with its own timestamp rather than batching across timestamps.
		let facts = 0;
		for (const w of batch) {
			if (w.kind === "fact") {
				await c.addFacts(ref, [w.text], { createdAt: w.createdAt });
				facts++;
			} else {
				await c.addMessages(ref, [w.message], { ttlSeconds: w.ttlSeconds, createdAt: w.createdAt });
			}
		}
		logger.info({ facts, total: batch.length, sync: syncWritesEnabled() }, "flushed agent-memory writes");
	} catch (error) {
		if (error instanceof ServiceUnavailableError) {
			// Requeue (front) and let the next flush/teardown retry. Don't drop.
			queue.unshift(...batch);
			logger.warn(
				{ requeued: batch.length, retryAfterSeconds: error.retryAfterSeconds },
				"agent-memory queue saturated (503); requeued writes for retry",
			);
			return;
		}
		logger.warn(
			{ dropped: batch.length, error: error instanceof Error ? error.message : String(error) },
			"agent-memory flush failed; writes dropped",
		);
	}
}

// SIO-942: per-turn drain. Persists this turn's enqueued blocks without ending
// the session (contrast endAgentMemorySession, which also closes it and clears
// activeRef). Rebinds the active session first so blocks still flush when the
// bootstrap recall failed and activeRef was never set (e.g. service was down at
// session start). Best-effort: flushAgentMemory early-returns on an empty queue
// and swallows/requeues its own errors, so this is cheap and safe to call after
// every completed turn.
export async function flushAgentMemoryAfterTurn(agentName: string, threadId: string): Promise<void> {
	if (selectedBackend() !== "agent-memory") return;
	setActiveMemorySession(agentName, threadId);
	await flushAgentMemory();
}

// Semantic recall across the agent's past sessions for the given query.
// Returns undefined on any failure or empty result (caller degrades gracefully).
export async function recallAgentMemory(
	agentName: string,
	threadId: string,
	query: string,
): Promise<string | undefined> {
	const ref: AgentMemoryUserRef = { userId: resolveUserId(agentName), sessionId: threadId };
	try {
		const c = client();
		await c.ensureUser(ref.userId, agentName);
		await c.ensureSession(ref.userId, ref.sessionId);
		const hits = await c.searchMemory(ref, query, { allSessions: true, relevantK: 8 });
		// hits are ranked by rel_score; keep the service order and join the text.
		return hits.length > 0 ? hits.map((h) => h.text).join("\n") : undefined;
	} catch (error) {
		logger.warn({ error: error instanceof Error ? error.message : String(error) }, "agent-memory recall failed");
		return undefined;
	}
}

// Drain + end the session. Called at teardown.
export async function endAgentMemorySession(): Promise<void> {
	await flushAgentMemory();
	const ref = activeRef;
	if (!ref) return;
	try {
		await client().endSession(ref);
	} catch (error) {
		logger.warn({ error: error instanceof Error ? error.message : String(error) }, "agent-memory endSession failed");
	} finally {
		clearActiveMemorySession();
	}
}

// Readiness probe (GET /health). Never throws. Used to skip recall against a
// dead/saturated service while still binding the session so writes queue for a
// later retry.
export async function agentMemoryHealthy(): Promise<boolean> {
	try {
		return (await client().checkHealth()).ok;
	} catch {
		return false;
	}
}

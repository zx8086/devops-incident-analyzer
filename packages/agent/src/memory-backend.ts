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
	type AnnotationMap,
	type ChatMessageBlock,
	createFetchAgentMemoryClient,
	resolveAgentMemoryConfig,
	ServiceUnavailableError,
	SessionAlreadyEndedError,
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

// SIO-952: the agent's role, recorded as user metadata for annotation-based
// attribution/access control. elastic-iac is the IaC maker; the orchestrator
// correlates incidents.
function resolveRole(agentName: string): string {
	return agentName === "elastic-iac" ? "iac-maker" : "incident-correlator";
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
	activeDatasources = undefined;
	activeOutcome = undefined;
}

// SIO-952: conversation-scoped annotations. datasources labels the session at
// creation; outcome is stamped at teardown via updateSession. Both are best-effort
// context the graph knows (intent/datasources/outcome already exist in state).
let activeDatasources: string | undefined;
let activeOutcome: string | undefined;
export function setSessionDatasources(datasources: string | undefined): void {
	if (datasources) activeDatasources = datasources;
}
export function setSessionOutcome(outcome: string | undefined): void {
	if (outcome) activeOutcome = outcome;
}

type QueuedWrite =
	| { kind: "fact"; text: string; createdAt: string; annotations?: AnnotationMap }
	| { kind: "message"; message: ChatMessageBlock; ttlSeconds?: number; createdAt: string; annotations?: AnnotationMap };
const queue: QueuedWrite[] = [];

// Drain when the queue grows large so a long session does not accumulate
// unboundedly; failures are swallowed (best-effort, never block the agent).
const FLUSH_THRESHOLD = 25;

// SIO-952: stamp block kind so recall can filter daily-log noise from durable
// key-decisions; merge any caller-supplied annotations (e.g. { intent }).
function factAnnotations(extra?: AnnotationMap): AnnotationMap {
	return { kind: "key-decision", ...extra };
}
function messageAnnotations(extra?: AnnotationMap): AnnotationMap {
	return { kind: "daily-log", ...extra };
}

export function enqueueFact(text: string, createdAt: string, annotations?: AnnotationMap): void {
	queue.push({ kind: "fact", text, createdAt, annotations: factAnnotations(annotations) });
	maybeFlush();
}

export function enqueueMessage(
	message: ChatMessageBlock,
	createdAt: string,
	ttlSeconds?: number,
	annotations?: AnnotationMap,
): void {
	queue.push({ kind: "message", message, ttlSeconds, createdAt, annotations: messageAnnotations(annotations) });
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
// SIO-952: which agent owns the conversation + which datasources it spans.
function sessionAnnotations(): AnnotationMap {
	const a: AnnotationMap = { agent: activeAgentName };
	if (activeDatasources) a.datasources = activeDatasources;
	return a;
}

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
		await c.ensureUser(ref.userId, activeAgentName, { agent: activeAgentName, role: resolveRole(activeAgentName) });
		await c.ensureSession(ref.userId, ref.sessionId, { annotations: sessionAnnotations() });
		// Per-block createdAt feeds the service's conflict resolution, so send each
		// block with its own timestamp rather than batching across timestamps.
		let facts = 0;
		for (const w of batch) {
			if (w.kind === "fact") {
				await c.addFacts(ref, [w.text], { createdAt: w.createdAt, annotations: w.annotations });
				facts++;
			} else {
				await c.addMessages(ref, [w.message], {
					ttlSeconds: w.ttlSeconds,
					createdAt: w.createdAt,
					annotations: w.annotations,
				});
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
		if (error instanceof SessionAlreadyEndedError) {
			// SIO-956: the conversation's session is closed; these late writes cannot
			// land and there is nothing to retry. Clear the stale ref and move on
			// quietly — this is expected after a conversation ends, not a failure.
			clearActiveMemorySession();
			logger.debug({ dropped: batch.length }, "agent-memory flush after session end; writes discarded");
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
		await c.ensureUser(ref.userId, agentName, { agent: agentName, role: resolveRole(agentName) });
		await c.ensureSession(ref.userId, ref.sessionId, { annotations: { agent: agentName } });
		const hits = await c.searchMemory(ref, query, { allSessions: true, relevantK: 8 });
		// hits are ranked by rel_score; keep the service order and join the text.
		return hits.length > 0 ? hits.map((h) => h.text).join("\n") : undefined;
	} catch (error) {
		logger.warn({ error: error instanceof Error ? error.message : String(error) }, "agent-memory recall failed");
		return undefined;
	}
}

// SIO-959: a dispatched fleet upgrade recovered from durable memory across sessions.
export interface InFlightFleetUpgrade {
	deployment?: string;
	version?: string;
	pipelineId?: number;
	text: string;
}

// SIO-959: recover fleet upgrades the agent dispatched in ANY past session that are
// still in flight, so a new conversation can re-poll them ("how's the us-cld upgrade
// going?") and surface them at session start. Reads the structured annotations
// (kind=fleet-upgrade-dispatched) the teardown writer stamped -- no prose parsing.
// Best-effort: agent-memory backend only; returns [] on any failure or when disabled.
export async function recallInFlightFleetUpgrades(agentName: string): Promise<InFlightFleetUpgrade[]> {
	if (selectedBackend() !== "agent-memory") return [];
	const userId = resolveUserId(agentName);
	// allSessions search needs a session ref; bind a transient one (any session id
	// works -- the filter spans all sessions for the user).
	const ref: AgentMemoryUserRef = { userId, sessionId: activeRef?.sessionId ?? "recall" };
	try {
		const c = client();
		await c.ensureUser(userId, agentName, { agent: agentName, role: resolveRole(agentName) });
		await c.ensureSession(userId, ref.sessionId, { annotations: { agent: agentName } });
		const hits = await c.searchMemory(ref, "in-flight fleet upgrades", {
			allSessions: true,
			relevantK: 8,
			annotations: { kind: "fleet-upgrade-dispatched" },
		});
		return hits.map((h) => {
			const a = h.annotations ?? {};
			const pid = a.pipeline_id ? Number(a.pipeline_id) : undefined;
			return {
				deployment: a.deployment,
				version: a.version,
				pipelineId: Number.isFinite(pid) ? pid : undefined,
				text: h.text,
			};
		});
	} catch (error) {
		logger.warn(
			{ error: error instanceof Error ? error.message : String(error) },
			"agent-memory in-flight fleet recall failed",
		);
		return [];
	}
}

// Drain + end the session. Called at teardown. SIO-952: stamps the final
// outcome annotation (best-effort) before closing so the conversation's result
// is queryable, then POSTs the corrected /sessions/{id}/end endpoint.
//
// SIO-955: bind the session from the explicit (agentName, threadId) when given,
// mirroring flushAgentMemoryAfterTurn's defensive rebind. The unload-beacon and
// idle-TTL-sweep teardown paths run cold (no in-process turn bound activeRef, or
// it points at a different thread), so relying on the module-global activeRef
// alone silently no-ops and end_time stays null. The caller always knows the
// thread to end; honour it. Falls back to activeRef when args are omitted.
export async function endAgentMemorySession(agentName?: string, threadId?: string): Promise<void> {
	if (agentName && threadId) setActiveMemorySession(agentName, threadId);
	await flushAgentMemory();
	const ref = activeRef;
	if (!ref) return;
	try {
		const c = client();
		if (activeOutcome) {
			await c.updateSession(ref, { annotations: { outcome: activeOutcome } });
		}
		await c.endSession(ref);
	} catch (error) {
		// SIO-956: ending an already-ended session is idempotent success, not a
		// failure — a second teardown (pagehide after Clear, re-fired beacon) is
		// expected. Log at debug; only real failures warn.
		if (error instanceof SessionAlreadyEndedError) {
			logger.debug({ sessionId: ref.sessionId }, "agent-memory session already ended; teardown is a no-op");
		} else {
			logger.warn({ error: error instanceof Error ? error.message : String(error) }, "agent-memory endSession failed");
		}
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

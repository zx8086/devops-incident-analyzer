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
	type AgentMemoryHealth,
	type AgentMemoryUserRef,
	type AnnotationMap,
	BackendUnavailableError,
	type ChatMessageBlock,
	createFetchAgentMemoryClient,
	resolveAgentMemoryConfig,
	ServiceUnavailableError,
	SessionAlreadyEndedError,
	SessionNotFoundError,
} from "@devops-agent/shared";
import { z } from "zod";

const logger = getLogger("agent:memory-backend");

// SIO-1170: pino's default JSON serializer drops non-enumerable Error fields
// (message/stack), and Node's fetch() throws a bare "fetch failed" TypeError
// whose real cause (ECONNREFUSED, DNS failure, etc.) lives one level deeper in
// `.cause` (and in `.errors` when it's an AggregateError). Mirrors
// serializeMcpConnectError in mcp-bridge.ts so a total-outage flush failure
// logs the actual reason instead of the opaque "fetch failed" string.
function isNetworkFailure(error: unknown): boolean {
	return error instanceof TypeError && error.message === "fetch failed";
}
// CodeRabbit (PR #437): a single-level unwrap missed an AggregateError nested inside `.cause`
// (or a `.errors` member with its own `.cause`) -- e.g. Node's fetch() can throw a TypeError
// whose `.cause` is itself an AggregateError of per-address connection attempts. Recurse with a
// depth cap so a pathological/cyclic cause chain can't loop forever.
const MAX_CAUSE_DEPTH = 5;
function collectCauseMessages(candidate: unknown, depth: number, out: string[]): void {
	if (depth > MAX_CAUSE_DEPTH) return;
	if (candidate instanceof AggregateError) {
		for (const child of candidate.errors) collectCauseMessages(child, depth + 1, out);
		return;
	}
	if (candidate instanceof Error) {
		if (candidate.message) out.push(candidate.message);
		if ("cause" in candidate && candidate.cause !== undefined) collectCauseMessages(candidate.cause, depth + 1, out);
		return;
	}
	if (typeof candidate === "string" && candidate) out.push(candidate);
}
function describeError(error: unknown): { error: string; cause?: string } {
	if (error instanceof Error) {
		const causeMessages: string[] = [];
		if ("cause" in error && error.cause !== undefined) collectCauseMessages(error.cause, 1, causeMessages);
		if (error instanceof AggregateError) {
			for (const child of error.errors) collectCauseMessages(child, 1, causeMessages);
		}
		return {
			error: error.message || error.name || "unknown error",
			...(causeMessages.length > 0 && { cause: [...new Set(causeMessages)].join("; ") }),
		};
	}
	if (typeof error === "string") return { error };
	try {
		return { error: JSON.stringify(error) ?? String(error) };
	} catch {
		return { error: String(error) };
	}
}

export type LiveMemoryBackend = "file" | "agent-memory";

export function selectedBackend(): LiveMemoryBackend {
	return process.env.LIVE_MEMORY_BACKEND === "agent-memory" ? "agent-memory" : "file";
}

// Agent identity -> Agent Memory user_id and role. One user per agent (SIO-938
// decision 3; role recorded as user metadata, SIO-952). The map is explicit and
// an unregistered agent throws at first use, so a new agent can never silently
// share another agent's memory (SIO-1635 Phase 0).
type AgentMemoryIdentity = { userId: string; role: string };

const AGENT_MEMORY_IDENTITIES: Readonly<Record<string, AgentMemoryIdentity>> = {
	"incident-analyzer": { userId: "incident-analyzer", role: "incident-correlator" },
	"elastic-iac": { userId: "elastic-iac", role: "iac-maker" },
};

export function resolveAgentMemoryIdentity(agentName: string): AgentMemoryIdentity {
	const identity = AGENT_MEMORY_IDENTITIES[agentName];
	if (!identity) {
		throw new Error(
			`No Agent Memory identity registered for agent "${agentName}"; add it to AGENT_MEMORY_IDENTITIES in memory-backend.ts`,
		);
	}
	return identity;
}

export function resolveUserId(agentName: string): string {
	return resolveAgentMemoryIdentity(agentName).userId;
}

export function resolveRole(agentName: string): string {
	return resolveAgentMemoryIdentity(agentName).role;
}

// For call sites that only hold the resolved user id (the write-behind queue).
export function roleForUserId(userId: string): string {
	const hit = Object.values(AGENT_MEMORY_IDENTITIES).find((identity) => identity.userId === userId);
	if (!hit) throw new Error(`No Agent Memory identity has user id "${userId}"`);
	return hit.role;
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
// SIO-991: the active session's Couchbase coordinates (user_id = agent, session_id = threadId),
// so the synchronous writer can stamp enqueue-time logs with the keys a flush later resolves to
// block ids. null when no in-process turn is bound (writes still enqueue; the flush log has the ref).
export function getActiveMemoryRef(): AgentMemoryUserRef | null {
	return activeRef;
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
	// SIO-1005: facts are durable by default (no ttlSeconds), but the proposal iac-change fact can
	// carry a TTL so it auto-expires once the reconciliation pass has written the durable terminal
	// fact -- keeping the append-only store at ~one fact per settled MR instead of two.
	// SIO-1364 (CodeRabbit PR #582): `ref` pins the session bound at enqueue time so a write held
	// across a session rebind (saturation cooldown, 503 requeue) still lands in its own session.
	| {
			kind: "fact";
			text: string;
			createdAt: string;
			annotations?: AnnotationMap;
			ttlSeconds?: number;
			ref: AgentMemoryUserRef | null;
	  }
	| {
			kind: "message";
			message: ChatMessageBlock;
			ttlSeconds?: number;
			createdAt: string;
			annotations?: AnnotationMap;
			ref: AgentMemoryUserRef | null;
	  };
// A write whose session ref resolved (enqueue-time ref or the flush-time fallback).
type SendableWrite = QueuedWrite & { ref: AgentMemoryUserRef };
const queue: QueuedWrite[] = [];

// Drain when the queue grows large so a long session does not accumulate
// unboundedly; failures are swallowed (best-effort, never block the agent).
const FLUSH_THRESHOLD = 25;

// SIO-1364: honor the service's 503 retry_after_seconds hint. While the cooldown
// is active, threshold- and per-turn flush triggers are skipped (writes keep
// queueing) so the client stops re-hitting an extraction queue that asked for
// backoff -- previously every enqueue past the threshold retried immediately.
// flushAgentMemory() itself stays ungated: teardown calls it directly as the
// last chance to drain before the session closes.
const DEFAULT_SATURATION_COOLDOWN_SECONDS = 30;
// SIO-1364 (CodeRabbit PR #582): the retry hint originates from an unvalidated
// 503 body or Retry-After header; only a positive finite number is honored.
const retryAfterHintSchema = z.number().finite().positive();
let saturatedUntil = 0;

// SIO-1646: the service's Couchbase store can be down while GET /health still says healthy
// (observed live 2026-09-06: every data call returned 400 USER_ERROR "couchbase.network", six
// warns per request, the flush dropped its batch on the ensure preamble, and teardown 404'd a
// session that was never created). Three pieces make that cost ONE warn per window instead:
//   - ensureUser/ensureSession are memoized per process (added only after success);
//   - any BackendUnavailableError or fetch-level failure arms a process-wide cooldown that
//     short-circuits the WRITE sites (queued flush, per-turn flush, direct fact write) while
//     inside the window; READ sites (recall/search/fleet-recall) are still attempted because the
//     observed outage class is write-only (reads keep working), and a read that does fail folds
//     into the same window via noteBackendUnavailable. The teardown flush stays ungated
//     (SIO-1364 invariant) as the last chance to drain;
//   - the queue is bounded so a dead backend cannot grow it without limit across a long session.
export const MAX_QUEUED_WRITES = 200;
const DEFAULT_DEGRADED_COOLDOWN_SECONDS = 60;
let backendDegradedUntil = 0;
let droppedOverflow = 0;
const ensuredUsers = new Set<string>();
const ensuredSessions = new Set<string>();

function sessionKey(userId: string, sessionId: string): string {
	return `${userId}/${sessionId}`;
}

// Memoized user + session bootstrap. A transient failure leaves the memo untouched (nothing was
// confirmed), so the next call after the cooldown retries; a success is remembered for the
// process lifetime because the service-side effect (409-tolerant create) is permanent.
async function ensureUserAndSession(
	c: AgentMemoryClient,
	userId: string,
	sessionId: string,
	name: string,
	userMetadata: AnnotationMap,
	sessionAnnotations: AnnotationMap,
): Promise<void> {
	if (!ensuredUsers.has(userId)) {
		await c.ensureUser(userId, name, userMetadata);
		ensuredUsers.add(userId);
	}
	const key = sessionKey(userId, sessionId);
	if (!ensuredSessions.has(key)) {
		await c.ensureSession(userId, sessionId, { annotations: sessionAnnotations });
		ensuredSessions.add(key);
	}
}

// Best-effort variant for READ paths. The observed outage class is WRITE-ONLY: the service's
// Couchbase reads (get/search) keep working while mutations fail with a network error (verified
// live 2026-09-06 -- a degraded write path, reads and FTS search unaffected). ensureUserAndSession
// is itself a write, so on a write-only outage it throws and would block a recall that could still
// run against an already-created session. Swallow a transient ensure failure and let the caller
// attempt the read anyway: if the session already exists the search succeeds; if it does not the
// search fails its own 404/transient and folds into the same cooldown window. A non-transient
// ensure error still throws (a real problem, not a degraded backend).
async function ensureUserAndSessionForRead(
	c: AgentMemoryClient,
	userId: string,
	sessionId: string,
	name: string,
	userMetadata: AnnotationMap,
	sessionAnnotations: AnnotationMap,
): Promise<void> {
	try {
		await ensureUserAndSession(c, userId, sessionId, name, userMetadata, sessionAnnotations);
	} catch (error) {
		if (isTransientBackendFailure(error)) return;
		throw error;
	}
}

function isTransientBackendFailure(error: unknown): boolean {
	return error instanceof BackendUnavailableError || isNetworkFailure(error);
}

// The single place a backend outage is logged: warn on entering the window, debug while inside
// it (every later site extends the window instead of re-warning).
function noteBackendUnavailable(site: string, error: unknown, extra: Record<string, unknown> = {}): void {
	const now = Date.now();
	const inWindow = now < backendDegradedUntil;
	const hint = retryAfterHintSchema.safeParse(
		error instanceof BackendUnavailableError ? error.retryAfterSeconds : undefined,
	);
	const cooldownSeconds = hint.success ? hint.data : DEFAULT_DEGRADED_COOLDOWN_SECONDS;
	backendDegradedUntil = now + cooldownSeconds * 1000;
	const fields = { site, cooldownSeconds, ...extra, ...describeError(error) };
	if (inWindow) logger.debug(fields, "agent-memory backend still unavailable; cooldown extended");
	else logger.warn(fields, "agent-memory backend unavailable; skipping memory calls for the cooldown window");
}

// Gate for WRITE sites only: reads stay attempted during a write-only outage (see the block
// comment above). Callers that skip on true are the direct-fact write and the two flush triggers.
function backendDegraded(site: string): boolean {
	if (Date.now() >= backendDegradedUntil) return false;
	logger.debug({ site }, "agent-memory backend degraded; skipping write");
	return true;
}

// Drop-oldest past the cap: the most recent turn's writes are the ones teardown cares about.
// The count is reported once, on the next flush log line, never per write.
function trimQueue(): void {
	while (queue.length > MAX_QUEUED_WRITES) {
		queue.shift();
		droppedOverflow += 1;
	}
}
function takeDroppedOverflow(): { droppedOverflow?: number } {
	if (droppedOverflow === 0) return {};
	const n = droppedOverflow;
	droppedOverflow = 0;
	return { droppedOverflow: n };
}

// SIO-952: stamp block kind so recall can filter daily-log noise from durable
// key-decisions; merge any caller-supplied annotations (e.g. { intent }).
function factAnnotations(extra?: AnnotationMap): AnnotationMap {
	return { kind: "key-decision", ...extra };
}
function messageAnnotations(extra?: AnnotationMap): AnnotationMap {
	return { kind: "daily-log", ...extra };
}

export function enqueueFact(text: string, createdAt: string, annotations?: AnnotationMap, ttlSeconds?: number): void {
	// SIO-1005: ttlSeconds is optional and defaults to undefined -> a durable fact (no decay), so every
	// existing caller is unchanged. Only the proposal iac-change fact passes a TTL.
	queue.push({ kind: "fact", text, createdAt, annotations: factAnnotations(annotations), ttlSeconds, ref: activeRef });
	trimQueue();
	maybeFlush();
}

export function enqueueMessage(
	message: ChatMessageBlock,
	createdAt: string,
	ttlSeconds?: number,
	annotations?: AnnotationMap,
): void {
	queue.push({
		kind: "message",
		message,
		ttlSeconds,
		createdAt,
		annotations: messageAnnotations(annotations),
		ref: activeRef,
	});
	trimQueue();
	maybeFlush();
}

export function pendingWriteCount(): number {
	return queue.length;
}

// Test-only: drop any queued writes without sending. Prevents cross-test residue
// in the process-global queue (Bun runs a package's test files in one process).
export function __resetMemoryQueue(): void {
	queue.length = 0;
	saturatedUntil = 0;
	backendDegradedUntil = 0;
	droppedOverflow = 0;
	ensuredUsers.clear();
	ensuredSessions.clear();
}

function maybeFlush(): void {
	if (Date.now() < saturatedUntil || Date.now() < backendDegradedUntil) return;
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
	// SIO-1364 (CodeRabbit PR #582): each write flushes under the session that
	// enqueued it, not the module-global activeRef alone. A saturation cooldown
	// (or a plain 503 requeue) can hold session A's writes across a rebind to
	// session B; the enqueue-time ref keeps them attributed to A. Writes enqueued
	// before any session was bound adopt the currently bound session.
	const fallbackRef = activeRef;
	const batch = queue.splice(0, queue.length).map((w) => ({ ...w, ref: w.ref ?? fallbackRef }));
	const sendable = batch.filter((w): w is SendableWrite => w.ref !== null);
	if (sendable.length < batch.length) {
		logger.warn(
			{ dropped: batch.length - sendable.length },
			"agent-memory flush with no active session; dropping writes",
		);
	}
	if (sendable.length === 0) return;
	// SIO-1646: how many writes the service ACCEPTED before a failure, and which ref was in
	// flight -- the catch requeues only the unsent tail and invalidates only that session's memo.
	let sent = 0;
	let failingRef: AgentMemoryUserRef | null = null;
	try {
		const c = client();
		// Ensure user + session once per distinct ref in the batch (idempotent,
		// 409-tolerant). The agent identity derives from the ref's userId (the two
		// coincide for both known agents) so a cross-session retry never stamps
		// the currently bound agent onto another session's user.
		const ensured = new Set<string>();
		// Per-block createdAt feeds the service's conflict resolution, so send each
		// block with its own timestamp rather than batching across timestamps.
		let facts = 0;
		// SIO-991: collect the created Couchbase block ids so the flush log can be cross-referenced
		// against the actual memory-block documents in Capella (keyed by userId/sessionId/blockId).
		const blockIds: string[] = [];
		let rejected = 0;
		let primary = fallbackRef;
		for (const w of sendable) {
			primary ??= w.ref;
			failingRef = w.ref;
			const ensureKey = sessionKey(w.ref.userId, w.ref.sessionId);
			if (!ensured.has(ensureKey)) {
				// SIO-1646: memoized per process inside ensureUserAndSession; the batch-local
				// set only keeps the per-flush "sessions" count.
				await ensureUserAndSession(
					c,
					w.ref.userId,
					w.ref.sessionId,
					w.ref.userId,
					{ agent: w.ref.userId, role: roleForUserId(w.ref.userId) },
					sessionAnnotations(),
				);
				ensured.add(ensureKey);
			}
			const res =
				w.kind === "fact"
					? await c.addFacts(w.ref, [w.text], {
							// SIO-1005: ttlSeconds is undefined for ordinary durable facts (no decay); only the
							// proposal iac-change fact sets it. addFacts forwards it as memory_block_ttl.
							ttlSeconds: w.ttlSeconds,
							createdAt: w.createdAt,
							annotations: w.annotations,
						})
					: await c.addMessages(w.ref, [w.message], {
							ttlSeconds: w.ttlSeconds,
							createdAt: w.createdAt,
							annotations: w.annotations,
						});
			if (w.kind === "fact") facts++;
			blockIds.push(...res.blockIds);
			rejected += res.rejectedCount;
			sent += 1;
		}
		logger.info(
			{
				userId: primary?.userId,
				sessionId: primary?.sessionId,
				...(ensured.size > 1 && { sessions: ensured.size }),
				facts,
				total: sendable.length,
				blockIds,
				...(rejected > 0 && { rejected }),
				...takeDroppedOverflow(),
				sync: syncWritesEnabled(),
			},
			"flushed agent-memory writes",
		);
		saturatedUntil = 0;
		backendDegradedUntil = 0;
	} catch (error) {
		// SIO-1646: writes the service already accepted earlier in this batch are never
		// resent (facts are undeletable, so a whole-batch requeue double-wrote them).
		const unsent = sendable.slice(sent);
		if (error instanceof ServiceUnavailableError) {
			// Requeue (front) and let the next flush/teardown retry. Don't drop.
			// Refs were pinned above, so a retry under a different bound session
			// still lands each write in its originating session.
			queue.unshift(...unsent);
			trimQueue();
			const hint = retryAfterHintSchema.safeParse(error.retryAfterSeconds);
			const cooldownSeconds = hint.success ? hint.data : DEFAULT_SATURATION_COOLDOWN_SECONDS;
			saturatedUntil = Date.now() + cooldownSeconds * 1000;
			logger.warn(
				{
					requeued: unsent.length,
					retryAfterSeconds: error.retryAfterSeconds,
					cooldownSeconds,
					// SIO-1364: surface the service's 503 response body (method, path, and
					// capacity detail). The service rejects these requests BEFORE its own
					// request-logging middleware, so this warn is the only record of why.
					error: error.message,
				},
				"agent-memory queue saturated (503); requeued writes for retry",
			);
			return;
		}
		if (error instanceof BackendUnavailableError) {
			// SIO-1646: the service's store is down (ensure preamble or a data call); nothing
			// partial was applied, so requeue and let the cooldown pace the retry.
			queue.unshift(...unsent);
			trimQueue();
			noteBackendUnavailable("flush", error, { requeued: unsent.length });
			return;
		}
		if (error instanceof SessionAlreadyEndedError) {
			// SIO-956: the conversation's session is closed; these late writes cannot
			// land and there is nothing to retry. Clear the stale ref and move on
			// quietly — this is expected after a conversation ends, not a failure.
			if (failingRef) ensuredSessions.delete(sessionKey(failingRef.userId, failingRef.sessionId));
			clearActiveMemorySession();
			logger.debug({ dropped: unsent.length }, "agent-memory flush after session end; writes discarded");
			return;
		}
		if (error instanceof SessionNotFoundError && failingRef) {
			// The service lost (or never had) this session; the next flush recreates it.
			ensuredSessions.delete(sessionKey(failingRef.userId, failingRef.sessionId));
		}
		if (isNetworkFailure(error)) {
			// SIO-1170: a total-outage fetch failure is not transient like a 503, so still
			// drop the batch, but log loudly with the unwrapped cause -- this is the case
			// that previously read as an opaque "fetch failed" warn with no signal that the
			// backend itself was unreachable for the whole session.
			// SIO-1646: it does arm the cooldown, so the rest of the session stops hammering.
			noteBackendUnavailable("flush", error, { dropped: unsent.length });
			logger.error(
				{ dropped: unsent.length, ...describeError(error) },
				"agent-memory unreachable; flush dropped writes",
			);
			return;
		}
		logger.warn(
			{
				dropped: unsent.length,
				...takeDroppedOverflow(),
				error: error instanceof Error ? error.message : String(error),
			},
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
	// SIO-1364: respect an active saturation cooldown; queued writes ride along
	// to a later turn or teardown instead of re-hitting a 503ing service.
	// SIO-1646: same for the backend-unavailable cooldown.
	if (Date.now() < saturatedUntil || Date.now() < backendDegradedUntil) return;
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
	// A write-only outage must not suppress recall (reads keep working); attempt it, best-effort ensure.
	try {
		const c = client();
		await ensureUserAndSessionForRead(
			c,
			ref.userId,
			ref.sessionId,
			agentName,
			{ agent: agentName, role: resolveRole(agentName) },
			{ agent: agentName },
		);
		const hits = await c.searchMemory(ref, query, { allSessions: true, relevantK: 8 });
		// SIO-991: trace the bootstrap recall to its Capella documents (userId/sessionId/blockIds).
		logger.info(
			{
				userId: ref.userId,
				sessionId: ref.sessionId,
				hitCount: hits.length,
				blockIds: hits.map((h) => h.blockId).filter((id): id is string => Boolean(id)),
			},
			"agent-memory recall",
		);
		// hits are ranked by rel_score; keep the service order. SIO-1015: collapse
		// duplicate skill proposals (durable facts double on re-record) by skill_name,
		// and prefix kind:skill lines so they read as unpromoted proposals, not
		// established facts. Non-skill hits pass through unchanged.
		const seenSkills = new Set<string>();
		const lines: string[] = [];
		for (const h of hits) {
			if (h.annotations?.kind === "skill") {
				const name = h.annotations.skill_name ?? "";
				if (name && seenSkills.has(name)) continue;
				if (name) seenSkills.add(name);
				lines.push(`[proposed-skill (unpromoted)] ${h.text}`);
				continue;
			}
			lines.push(h.text);
		}
		return lines.length > 0 ? lines.join("\n") : undefined;
	} catch (error) {
		if (isTransientBackendFailure(error)) {
			noteBackendUnavailable("recall", error);
			return undefined;
		}
		logger.warn({ error: error instanceof Error ? error.message : String(error) }, "agent-memory recall failed");
		return undefined;
	}
}

// SIO-966: on-demand semantic recall for the LLM-callable search_memory tool. Like
// recallAgentMemory but (a) spans all sessions for the agent without needing the
// current threadId, (b) accepts an optional annotations filter ({deployment, stack,
// kind, ...}) that joins to the knowledge-graph node keys, and (c) returns the hit
// text WITH its annotations so the model sees the structured labels. Agent-memory
// backend only; returns [] on any failure or when the backend is the file default.
export interface MemorySearchHit {
	text: string;
	annotations: AnnotationMap;
	// SIO-991: the Couchbase memory-block document id (when the service returned it), so a recall
	// log can be cross-referenced against the exact block in Capella.
	blockId?: string;
	// SIO-1072: the block's OWN session id (not the active conversation's) -- the DELETE endpoint
	// is session-scoped, so retiring a block found by cross-session search needs its home session.
	sessionId?: string;
}

// SIO-973: dedup recall hits by a stable identity key (e.g. pipeline_id, config_change_id)
// before rendering. Facts are durable + undeletable from the agent side, so any re-record
// (retried write, re-run, re-index) permanently doubles a fact; searchAgentMemory(allSessions)
// then returns both copies. keyFn returns undefined when the hit has no stable key -- those
// are kept as-is (deduped only against each other by a per-hit unique fallback). Order-preserving:
// the first (highest-ranked) hit for a key wins.
export function dedupeHitsBy(
	hits: MemorySearchHit[],
	keyFn: (hit: MemorySearchHit) => string | undefined,
): MemorySearchHit[] {
	const seen = new Set<string>();
	const out: MemorySearchHit[] = [];
	for (const [i, hit] of hits.entries()) {
		// no stable key -> unique fallback so distinct keyless hits are never collapsed together
		const key = keyFn(hit) ?? ` nokey:${i}`;
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(hit);
	}
	return out;
}

// SIO-1005: like dedupeHitsBy, but when several hits share a key it keeps the one with the highest
// rankFn instead of the first-seen one -- so a reconciled iac-change fact (lifecycle:applied) wins
// over the original proposal fact (no lifecycle) for the same mr_url. Crucially still ORDER-
// PRESERVING ACROSS keys: a group occupies the slot of its FIRST member, so the rendered list order
// (e.g. the plan-review "Recent changes" panel, newest MR first) is unchanged -- only each row's
// winning hit is upgraded. A global sort by rank would instead float every terminal change to the
// top and sink a brand-new open proposal, which is visually worse. Higher rankFn wins; ties keep the
// earlier hit. Keyless hits (keyFn -> undefined) are never collapsed together.
export function dedupePreferring(
	hits: MemorySearchHit[],
	keyFn: (hit: MemorySearchHit) => string | undefined,
	rankFn: (hit: MemorySearchHit) => number,
): MemorySearchHit[] {
	const slotByKey = new Map<string, number>();
	const out: MemorySearchHit[] = [];
	for (const [i, hit] of hits.entries()) {
		const key = keyFn(hit) ?? `\0nokey:${i}`;
		const slot = slotByKey.get(key);
		if (slot === undefined) {
			slotByKey.set(key, out.length);
			out.push(hit);
			continue;
		}
		const current = out[slot];
		if (current && rankFn(hit) > rankFn(current)) out[slot] = hit;
	}
	return out;
}

export async function searchAgentMemory(
	agentName: string,
	query: string,
	filter?: AnnotationMap,
	limit = 8,
	// SIO-992: allSessions defaults true (every existing caller does cross-session recall). Pass
	// false to scope the search to the CURRENT session only (ref.sessionId == threadId) -- the
	// service maps session_ids: undefined to the current session. Used by recallSessionProgress to
	// retrieve only THIS conversation's breadcrumbs.
	// SIO-998: deterministic=true selects FILTER-ONLY retrieval -- the annotation filter is the
	// authoritative WHERE clause (no FTS-KNN ranking, no relevant_k top-k truncation). Use it for an
	// IDENTIFIER-keyed recall (by mr_url/pipeline_id/config_change_id) where a query string would
	// rank the target out of the top-k window before the filter applies. The passed `query` is
	// ignored in this mode. See docs/architecture/agent-memory.md "Retrieval: TWO modes".
	opts?: { allSessions?: boolean; deterministic?: boolean },
): Promise<MemorySearchHit[]> {
	if (selectedBackend() !== "agent-memory") return [];
	const userId = resolveUserId(agentName);
	const ref: AgentMemoryUserRef = { userId, sessionId: activeRef?.sessionId ?? "recall" };
	const deterministic = opts?.deterministic ?? false;
	// Read path: attempt during a write-only outage (best-effort ensure), do not hard-skip.
	try {
		const c = client();
		await ensureUserAndSessionForRead(
			c,
			userId,
			ref.sessionId,
			agentName,
			{ agent: agentName, role: resolveRole(agentName) },
			{ agent: agentName },
		);
		const hits = await c.searchMemory(ref, deterministic ? "" : query, {
			allSessions: opts?.allSessions ?? true,
			// In deterministic mode the client omits relevant_k; passing it here is harmless (ignored).
			...(deterministic ? {} : { relevantK: limit }),
			...(filter && Object.keys(filter).length > 0 ? { annotations: filter } : {}),
		});
		// SIO-991: a success log carrying the Couchbase coordinates (userId/sessionId/blockIds) so a
		// recall can be traced to the exact memory-block documents in Capella, and an empty hit is no
		// longer silent (previously only errors logged).
		logger.info(
			{
				userId,
				sessionId: ref.sessionId,
				query: deterministic ? "" : query,
				// SIO-998: which retrieval path ran -- "deterministic" (filter-only) vs "semantic" (ranked).
				mode: deterministic ? "deterministic" : "semantic",
				...(filter && Object.keys(filter).length > 0 && { filter }),
				// SIO-992: scope is visible so a session-scoped progress recall is distinguishable from
				// the default cross-session recall.
				scope: (opts?.allSessions ?? true) ? "all-sessions" : "this-session",
				hitCount: hits.length,
				blockIds: hits.map((h) => h.blockId).filter((id): id is string => Boolean(id)),
			},
			"agent-memory search",
		);
		return hits.map((h) => ({
			text: h.text,
			annotations: h.annotations ?? {},
			...(h.blockId && { blockId: h.blockId }),
			...(h.sessionId && { sessionId: h.sessionId }),
		}));
	} catch (error) {
		if (isTransientBackendFailure(error)) {
			noteBackendUnavailable("search", error);
			return [];
		}
		logger.warn({ error: error instanceof Error ? error.message : String(error) }, "agent-memory search failed");
		return [];
	}
}

// SIO-1072: synchronous (non-queued) durable fact write. The fleet-settlement reconcile pass
// DELETES the stale dispatched block right after recording its terminal fact, so the write must be
// CONFIRMED stored before the delete -- the async write-behind queue can drop writes when no
// session is bound (headless cron sweep after a conversation ended), which would lose the
// upgrade's history entirely. Returns true only when the service accepted the fact.
export async function recordAgentFactNow(
	agentName: string,
	text: string,
	annotations: AnnotationMap,
): Promise<boolean> {
	if (selectedBackend() !== "agent-memory") return false;
	const userId = resolveUserId(agentName);
	// Mirrors searchAgentMemory's transient-session binding: any session id works as the write
	// container; recall is user-scoped (allSessions), not session-scoped.
	const ref: AgentMemoryUserRef = { userId, sessionId: activeRef?.sessionId ?? "recall" };
	if (backendDegraded("direct-fact")) return false;
	try {
		const c = client();
		await ensureUserAndSession(
			c,
			userId,
			ref.sessionId,
			agentName,
			{ agent: agentName, role: resolveRole(agentName) },
			{ agent: agentName },
		);
		const res = await c.addFacts(ref, [text], { annotations });
		logger.info(
			{ userId, sessionId: ref.sessionId, blockIds: res.blockIds, accepted: res.acceptedCount },
			"agent-memory direct fact write",
		);
		return res.acceptedCount > 0;
	} catch (error) {
		if (isTransientBackendFailure(error)) {
			noteBackendUnavailable("direct-fact", error);
			return false;
		}
		logger.warn(
			{ error: error instanceof Error ? error.message : String(error) },
			"agent-memory direct fact write failed",
		);
		return false;
	}
}

// SIO-1072: delete memory blocks by id. sessionId is the block's OWN home session (from the search
// hit), not the active conversation -- deletes work on ended sessions, which is the whole point
// (the dispatched fact's conversation is long closed; its PUT would 400 SESSION_ALREADY_ENDED).
// Best-effort: returns the deleted count, 0 on any failure or when the injected client predates
// the optional deleteMemoryBlocks method.
export async function deleteAgentMemoryBlocks(
	agentName: string,
	sessionId: string,
	blockIds: string[],
): Promise<number> {
	if (selectedBackend() !== "agent-memory" || blockIds.length === 0) return 0;
	const userId = resolveUserId(agentName);
	try {
		const c = client();
		if (!c.deleteMemoryBlocks) return 0;
		const res = await c.deleteMemoryBlocks({ userId, sessionId }, blockIds);
		logger.info({ userId, sessionId, blockIds, deleted: res.deletedCount }, "agent-memory blocks deleted");
		return res.deletedCount;
	} catch (error) {
		logger.warn(
			{ sessionId, blockIds, error: error instanceof Error ? error.message : String(error) },
			"agent-memory block delete failed",
		);
		return 0;
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
	// Read path: attempt during a write-only outage (best-effort ensure), do not hard-skip.
	try {
		const c = client();
		await ensureUserAndSessionForRead(
			c,
			userId,
			ref.sessionId,
			agentName,
			{ agent: agentName, role: resolveRole(agentName) },
			{ agent: agentName },
		);
		// SIO-998: keyed by kind -> deterministic filter-only retrieval (empty query omits relevant_k so
		// the annotation filter is authoritative, not a top-k window of a ranked "in-flight" query).
		const hits = await c.searchMemory(ref, "", {
			allSessions: true,
			annotations: { kind: "fleet-upgrade-dispatched" },
		});
		// SIO-991/SIO-1340: this recall bypasses the logged searchAgentMemory wrapper (it needs a
		// fixed annotation filter, not a caller-supplied query/filter), so it must log the
		// userId/sessionId/blockIds success trail itself -- every other recall function already does.
		logger.info(
			{
				userId,
				sessionId: ref.sessionId,
				hitCount: hits.length,
				blockIds: hits.map((h) => h.blockId).filter((id): id is string => Boolean(id)),
			},
			"agent-memory in-flight fleet recall",
		);
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
		if (isTransientBackendFailure(error)) {
			noteBackendUnavailable("fleet-recall", error);
			return [];
		}
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
		ensuredSessions.delete(sessionKey(ref.userId, ref.sessionId));
	} catch (error) {
		// SIO-956: ending an already-ended session is idempotent success, not a
		// failure — a second teardown (pagehide after Clear, re-fired beacon) is
		// expected. Log at debug; only real failures warn.
		if (error instanceof SessionAlreadyEndedError) {
			ensuredSessions.delete(sessionKey(ref.userId, ref.sessionId));
			logger.debug({ sessionId: ref.sessionId }, "agent-memory session already ended; teardown is a no-op");
		} else if (error instanceof SessionNotFoundError) {
			// SIO-1646: the session was never created (the backend was down at session
			// start), so there is nothing to end. The /end POST stays unconditional because
			// the SIO-955 cold path must still end sessions this process never ensured.
			ensuredSessions.delete(sessionKey(ref.userId, ref.sessionId));
			logger.debug(
				{ sessionId: ref.sessionId },
				"agent-memory session was never created (backend unavailable at session start); nothing to end",
			);
		} else if (isTransientBackendFailure(error)) {
			noteBackendUnavailable("endSession", error);
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
	return (await checkAgentMemoryHealth()).ok;
}

// SIO-1170: like agentMemoryHealthy, but returns the full status/detail so a
// caller (the startup probe) can log WHY the backend is unreachable instead of
// just that it is. Never throws.
export async function checkAgentMemoryHealth(): Promise<AgentMemoryHealth> {
	try {
		return await client().checkHealth();
	} catch (error) {
		const { error: message, cause } = describeError(error);
		return { ok: false, detail: cause ? `${message} (${cause})` : message };
	}
}

// SIO-1646: database probe (GET /health/couchbase); ok:true when the client predates it.
export async function checkAgentMemoryDatabaseHealth(): Promise<AgentMemoryHealth> {
	try {
		const c = client();
		if (!c.checkDatabaseHealth) return { ok: true };
		return await c.checkDatabaseHealth();
	} catch (error) {
		const { error: message, cause } = describeError(error);
		return { ok: false, detail: cause ? `${message} (${cause})` : message };
	}
}

// SIO-1170: the configured Agent Memory base URL, for logging context on a
// startup-probe failure. Best-effort -- returns undefined if config resolution
// itself throws (e.g. AGENT_MEMORY_BASE_URL missing/invalid).
export function agentMemoryBaseUrl(): string | undefined {
	try {
		return resolveAgentMemoryConfig().baseUrl;
	} catch {
		return undefined;
	}
}

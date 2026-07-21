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
	type ChatMessageBlock,
	createFetchAgentMemoryClient,
	resolveAgentMemoryConfig,
	ServiceUnavailableError,
	SessionAlreadyEndedError,
} from "@devops-agent/shared";

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
function describeError(error: unknown): { error: string; cause?: string } {
	if (error instanceof Error) {
		const candidates: unknown[] = [];
		if ("cause" in error && error.cause !== undefined) candidates.push(error.cause);
		if (error instanceof AggregateError) candidates.push(...error.errors);
		const causeMessages = candidates
			.map((c) => (c instanceof Error ? c.message : typeof c === "string" ? c : ""))
			.filter(Boolean);
		return {
			error: error.message || error.name || "unknown error",
			...(causeMessages.length > 0 && { cause: causeMessages.join("; ") }),
		};
	}
	return { error: typeof error === "string" ? error : JSON.stringify(error) };
}

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
	| { kind: "fact"; text: string; createdAt: string; annotations?: AnnotationMap; ttlSeconds?: number }
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

export function enqueueFact(text: string, createdAt: string, annotations?: AnnotationMap, ttlSeconds?: number): void {
	// SIO-1005: ttlSeconds is optional and defaults to undefined -> a durable fact (no decay), so every
	// existing caller is unchanged. Only the proposal iac-change fact passes a TTL.
	queue.push({ kind: "fact", text, createdAt, annotations: factAnnotations(annotations), ttlSeconds });
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
		// SIO-991: collect the created Couchbase block ids so the flush log can be cross-referenced
		// against the actual memory-block documents in Capella (keyed by userId/sessionId/blockId).
		const blockIds: string[] = [];
		let rejected = 0;
		for (const w of batch) {
			const res =
				w.kind === "fact"
					? await c.addFacts(ref, [w.text], {
							// SIO-1005: ttlSeconds is undefined for ordinary durable facts (no decay); only the
							// proposal iac-change fact sets it. addFacts forwards it as memory_block_ttl.
							ttlSeconds: w.ttlSeconds,
							createdAt: w.createdAt,
							annotations: w.annotations,
						})
					: await c.addMessages(ref, [w.message], {
							ttlSeconds: w.ttlSeconds,
							createdAt: w.createdAt,
							annotations: w.annotations,
						});
			if (w.kind === "fact") facts++;
			blockIds.push(...res.blockIds);
			rejected += res.rejectedCount;
		}
		logger.info(
			{
				userId: ref.userId,
				sessionId: ref.sessionId,
				facts,
				total: batch.length,
				blockIds,
				...(rejected > 0 && { rejected }),
				sync: syncWritesEnabled(),
			},
			"flushed agent-memory writes",
		);
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
		if (isNetworkFailure(error)) {
			// SIO-1170: a total-outage fetch failure is not transient like a 503, so still
			// drop the batch, but log loudly with the unwrapped cause -- this is the case
			// that previously read as an opaque "fetch failed" warn with no signal that the
			// backend itself was unreachable for the whole session.
			logger.error(
				{ dropped: batch.length, ...describeError(error) },
				"agent-memory unreachable; flush dropped writes",
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
		await c.ensureUser(ref.userId, agentName, { agent: agentName, role: resolveRole(agentName) });
		await c.ensureSession(ref.userId, ref.sessionId, { annotations: { agent: agentName } });
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
		const key = keyFn(hit) ?? ` nokey:${i}`;
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
	try {
		const c = client();
		await c.ensureUser(userId, agentName, { agent: agentName, role: resolveRole(agentName) });
		await c.ensureSession(userId, ref.sessionId, { annotations: { agent: agentName } });
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
	try {
		const c = client();
		await c.ensureUser(userId, agentName, { agent: agentName, role: resolveRole(agentName) });
		await c.ensureSession(userId, ref.sessionId, { annotations: { agent: agentName } });
		const res = await c.addFacts(ref, [text], { annotations });
		logger.info(
			{ userId, sessionId: ref.sessionId, blockIds: res.blockIds, accepted: res.acceptedCount },
			"agent-memory direct fact write",
		);
		return res.acceptedCount > 0;
	} catch (error) {
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
	try {
		const c = client();
		await c.ensureUser(userId, agentName, { agent: agentName, role: resolveRole(agentName) });
		await c.ensureSession(userId, ref.sessionId, { annotations: { agent: agentName } });
		// SIO-998: keyed by kind -> deterministic filter-only retrieval (empty query omits relevant_k so
		// the annotation filter is authoritative, not a top-k window of a ranked "in-flight" query).
		const hits = await c.searchMemory(ref, "", {
			allSessions: true,
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

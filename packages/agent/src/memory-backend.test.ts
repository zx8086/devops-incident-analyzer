// agent/src/memory-backend.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	type AgentMemoryClient,
	type AgentMemoryUserRef,
	type AnnotationMap,
	type ChatMessageBlock,
	redactPiiContent,
	ServiceUnavailableError,
	SessionAlreadyEndedError,
} from "@devops-agent/shared";
import {
	__resetMemoryQueue,
	__setAgentMemoryClient,
	clearActiveMemorySession,
	dedupeHitsBy,
	endAgentMemorySession,
	enqueueFact,
	enqueueMessage,
	flushAgentMemory,
	flushAgentMemoryAfterTurn,
	pendingWriteCount,
	recallAgentMemory,
	resolveUserId,
	selectedBackend,
	setActiveMemorySession,
	setSessionDatasources,
	setSessionOutcome,
} from "./memory-backend.ts";
import { appendDailyLog, recordKeyDecision } from "./memory-writer.ts";

// SIO-938: aggregator.test.ts mocks @devops-agent/shared with a passthrough
// redactPiiContent, and Bun's mock.module leaks across the run (last-wins,
// process-global). When that mock is active these redaction assertions are not
// meaningful, so gate them on the real function being present. The writer's
// redaction call is unconditional; this only avoids a false cross-file failure.
const REDACTION_ACTIVE = redactPiiContent("123-45-6789") !== "123-45-6789";

interface Recorded {
	users: string[];
	userMetadata: (AnnotationMap | undefined)[];
	sessions: string[];
	sessionAnnotations: (AnnotationMap | undefined)[];
	facts: string[];
	factAnnotations: (AnnotationMap | undefined)[];
	messages: ChatMessageBlock[];
	messageAnnotations: (AnnotationMap | undefined)[];
	searches: string[];
	updated: { ref: AgentMemoryUserRef; annotations?: AnnotationMap }[];
	ended: AgentMemoryUserRef[];
}

function makeFakeClient(searchResult: string[] = []): { client: AgentMemoryClient; rec: Recorded } {
	const rec: Recorded = {
		users: [],
		userMetadata: [],
		sessions: [],
		sessionAnnotations: [],
		facts: [],
		factAnnotations: [],
		messages: [],
		messageAnnotations: [],
		searches: [],
		updated: [],
		ended: [],
	};
	const client: AgentMemoryClient = {
		async ensureUser(userId, _name, metadata) {
			rec.users.push(userId);
			rec.userMetadata.push(metadata);
		},
		async ensureSession(_userId, sessionId, opts) {
			rec.sessions.push(sessionId);
			rec.sessionAnnotations.push(opts?.annotations);
		},
		async addFacts(_ref, facts, opts) {
			rec.facts.push(...facts);
			rec.factAnnotations.push(opts?.annotations);
		},
		async addMessages(_ref, messages, opts) {
			rec.messages.push(...messages);
			rec.messageAnnotations.push(opts?.annotations);
		},
		async searchMemory(_ref, query) {
			rec.searches.push(query);
			return searchResult.map((text) => ({ text }));
		},
		async updateSession(ref, patch) {
			rec.updated.push({ ref, annotations: patch.annotations });
		},
		async endSession(ref) {
			rec.ended.push(ref);
		},
		async checkHealth() {
			return { ok: true, status: "ok" };
		},
	};
	return { client, rec };
}

const prevBackend = process.env.LIVE_MEMORY_BACKEND;
const prevEnabled = process.env.LIVE_MEMORY_ENABLED;

beforeEach(() => {
	process.env.LIVE_MEMORY_ENABLED = "true";
	clearActiveMemorySession();
	// Drop any queued writes left by a sibling test (queue is process-global).
	__resetMemoryQueue();
});

afterEach(() => {
	if (prevBackend === undefined) delete process.env.LIVE_MEMORY_BACKEND;
	else process.env.LIVE_MEMORY_BACKEND = prevBackend;
	if (prevEnabled === undefined) delete process.env.LIVE_MEMORY_ENABLED;
	else process.env.LIVE_MEMORY_ENABLED = prevEnabled;
	__setAgentMemoryClient(null);
});

describe("selectedBackend / resolveUserId", () => {
	test("defaults to file, opts into agent-memory by env", () => {
		delete process.env.LIVE_MEMORY_BACKEND;
		expect(selectedBackend()).toBe("file");
		process.env.LIVE_MEMORY_BACKEND = "agent-memory";
		expect(selectedBackend()).toBe("agent-memory");
	});

	test("maps each agent to its own user id", () => {
		expect(resolveUserId("incident-analyzer")).toBe("incident-analyzer");
		expect(resolveUserId("elastic-iac")).toBe("elastic-iac");
		expect(resolveUserId("anything-else")).toBe("incident-analyzer");
	});
});

describe("writer -> agent-memory backend", () => {
	test("recordKeyDecision enqueues a redacted fact and flush sends it", async () => {
		process.env.LIVE_MEMORY_BACKEND = "agent-memory";
		const { client, rec } = makeFakeClient();
		__setAgentMemoryClient(client);
		setActiveMemorySession("incident-analyzer", "t-1");

		recordKeyDecision({ requestId: "r1", decision: "escalate; contact alice@external.com", rationale: "SLA breach" });
		await flushAgentMemory();

		expect(rec.users).toContain("incident-analyzer");
		expect(rec.sessions).toContain("t-1");
		expect(rec.facts).toHaveLength(1);
		expect(rec.facts[0]).toContain("rationale: SLA breach");
		if (REDACTION_ACTIVE) {
			expect(rec.facts[0]).toContain("[EMAIL_REDACTED]");
			expect(rec.facts[0]).not.toContain("alice@external.com");
		}
	});

	test("appendDailyLog enqueues a redacted conversational message", async () => {
		process.env.LIVE_MEMORY_BACKEND = "agent-memory";
		const { client, rec } = makeFakeClient();
		__setAgentMemoryClient(client);
		setActiveMemorySession("elastic-iac", "t-iac");

		appendDailyLog({
			requestId: "r2",
			services: ["eu-b2b"],
			datasources: ["elastic-iac"],
			severity: "high",
			summary: "downsized warm tier; notify bob@external.com",
		});
		await flushAgentMemory();

		expect(rec.messages).toHaveLength(1);
		const msg = rec.messages[0];
		expect(msg?.assistant_content).toContain("services=[eu-b2b]");
		if (REDACTION_ACTIVE) {
			expect(msg?.assistant_content).toContain("[EMAIL_REDACTED]");
			expect(msg?.assistant_content).not.toContain("bob@external.com");
		}
	});

	test("drops writes (does not throw) when no active session is bound", async () => {
		process.env.LIVE_MEMORY_BACKEND = "agent-memory";
		const { client, rec } = makeFakeClient();
		__setAgentMemoryClient(client);
		clearActiveMemorySession();
		enqueueMessage({ user_content: "x", assistant_content: "y" }, "2026-06-17T00:00:00Z");
		await flushAgentMemory();
		expect(rec.messages).toHaveLength(0); // dropped, no throw
	});
});

describe("flushAgentMemoryAfterTurn (SIO-942 per-turn flush)", () => {
	test("posts queued blocks mid-session and keeps the session open", async () => {
		process.env.LIVE_MEMORY_BACKEND = "agent-memory";
		const { client, rec } = makeFakeClient();
		__setAgentMemoryClient(client);

		enqueueMessage({ user_content: "q1", assistant_content: "a1" }, "2026-06-17T00:00:00Z");
		await flushAgentMemoryAfterTurn("incident-analyzer", "t-1");
		expect(rec.messages).toHaveLength(1);
		expect(rec.ended).toHaveLength(0); // session NOT ended

		// A second turn on the same session still posts (activeRef survived).
		enqueueMessage({ user_content: "q2", assistant_content: "a2" }, "2026-06-17T00:01:00Z");
		await flushAgentMemoryAfterTurn("incident-analyzer", "t-1");
		expect(rec.messages).toHaveLength(2);
		expect(rec.sessions).toContain("t-1");
	});

	test("defensive rebind persists blocks even when no session was bound", async () => {
		process.env.LIVE_MEMORY_BACKEND = "agent-memory";
		const { client, rec } = makeFakeClient();
		__setAgentMemoryClient(client);
		// No setActiveMemorySession: simulates a turn whose bootstrap recall failed.
		clearActiveMemorySession();
		enqueueMessage({ user_content: "q", assistant_content: "a" }, "2026-06-17T00:00:00Z");

		await flushAgentMemoryAfterTurn("elastic-iac", "t-iac");

		// Bare flushAgentMemory would have DROPPED this (see "drops writes" test);
		// the rebind binds elastic-iac/t-iac first, so the block is posted instead.
		expect(rec.messages).toHaveLength(1);
		expect(rec.users).toContain("elastic-iac");
		expect(rec.sessions).toContain("t-iac");
	});

	test("file backend: per-turn flush is a no-op (never touches the client)", async () => {
		delete process.env.LIVE_MEMORY_BACKEND; // default file
		const { client, rec } = makeFakeClient();
		__setAgentMemoryClient(client);
		enqueueMessage({ user_content: "q", assistant_content: "a" }, "2026-06-17T00:00:00Z");

		await flushAgentMemoryAfterTurn("incident-analyzer", "t-1");

		expect(rec.messages).toHaveLength(0);
		expect(rec.users).toHaveLength(0);
		expect(pendingWriteCount()).toBe(1); // queue untouched (gate returned early)
	});
});

describe("writer -> file backend (parity)", () => {
	test("file backend does not touch the agent-memory client", async () => {
		delete process.env.LIVE_MEMORY_BACKEND; // default file
		const { client, rec } = makeFakeClient();
		__setAgentMemoryClient(client);
		setActiveMemorySession("incident-analyzer", "t-1");
		// Route the file write to a throwaway temp dir so the tracked fixtures are
		// not mutated; the key assertion is that the agent-memory client is never invoked.
		const tmp = `${process.env.TMPDIR ?? "/tmp"}/sio938-${Date.now()}`;
		const { mkdirSync } = await import("node:fs");
		const { join } = await import("node:path");
		mkdirSync(join(tmp, "memory", "runtime"), { recursive: true });
		recordKeyDecision({ requestId: "r3", decision: "noop file path" }, tmp);
		await flushAgentMemory();
		expect(rec.facts).toHaveLength(0);
		expect(rec.users).toHaveLength(0);
	});
});

describe("recall + endSession", () => {
	test("recallAgentMemory ensures user/session then searches all sessions", async () => {
		const { client, rec } = makeFakeClient(["past incident: kafka lag", "decision: scaled consumers"]);
		__setAgentMemoryClient(client);
		const out = await recallAgentMemory("incident-analyzer", "t-1", "why was kafka slow");
		expect(rec.users).toContain("incident-analyzer");
		expect(rec.searches).toContain("why was kafka slow");
		expect(out).toContain("kafka lag");
		expect(out).toContain("scaled consumers");
	});

	test("recall returns undefined on empty result", async () => {
		const { client } = makeFakeClient([]);
		__setAgentMemoryClient(client);
		expect(await recallAgentMemory("incident-analyzer", "t-1", "q")).toBeUndefined();
	});

	test("endAgentMemorySession flushes then ends the bound session", async () => {
		process.env.LIVE_MEMORY_BACKEND = "agent-memory";
		const { client, rec } = makeFakeClient();
		__setAgentMemoryClient(client);
		setActiveMemorySession("elastic-iac", "t-iac");
		enqueueMessage({ user_content: "q", assistant_content: "a" }, "2026-06-17T00:00:00Z");
		await endAgentMemorySession();
		expect(rec.messages).toHaveLength(1);
		expect(rec.ended).toEqual([{ userId: "elastic-iac", sessionId: "t-iac" }]);
	});

	test("endAgentMemorySession stamps the outcome annotation before ending (SIO-952)", async () => {
		process.env.LIVE_MEMORY_BACKEND = "agent-memory";
		const { client, rec } = makeFakeClient();
		__setAgentMemoryClient(client);
		setActiveMemorySession("elastic-iac", "t-iac");
		setSessionOutcome("mr-opened");
		enqueueMessage({ user_content: "q", assistant_content: "a" }, "2026-06-17T00:00:00Z");
		await endAgentMemorySession();
		expect(rec.updated).toEqual([
			{ ref: { userId: "elastic-iac", sessionId: "t-iac" }, annotations: { outcome: "mr-opened" } },
		]);
		expect(rec.ended).toEqual([{ userId: "elastic-iac", sessionId: "t-iac" }]);
	});

	test("endAgentMemorySession(agentName, threadId) ends a session it never bound in-process (SIO-955)", async () => {
		// The cold-teardown path: the unload beacon / idle-TTL sweep calls teardown
		// in a process (or after a clear) where no turn ran, so activeRef is null.
		// Before SIO-955 endAgentMemorySession() took no args, read the null
		// activeRef, and early-returned -> end_time stayed null (reproduced live).
		process.env.LIVE_MEMORY_BACKEND = "agent-memory";
		const { client, rec } = makeFakeClient();
		__setAgentMemoryClient(client);
		clearActiveMemorySession(); // no in-process turn bound a session
		await endAgentMemorySession("elastic-iac", "t-cold");
		expect(rec.ended).toEqual([{ userId: "elastic-iac", sessionId: "t-cold" }]);
	});

	test("endAgentMemorySession(agentName, threadId) ends the GIVEN thread, not a stale bound one (SIO-955)", async () => {
		// Idle-TTL sweep: activeRef may point at a different (already-handled) thread.
		// The explicit args must win so the sweep ends the thread it intends to.
		process.env.LIVE_MEMORY_BACKEND = "agent-memory";
		const { client, rec } = makeFakeClient();
		__setAgentMemoryClient(client);
		setActiveMemorySession("elastic-iac", "t-other");
		await endAgentMemorySession("elastic-iac", "t-stale");
		expect(rec.ended).toEqual([{ userId: "elastic-iac", sessionId: "t-stale" }]);
	});

	test("endAgentMemorySession() still ends the bound session when called with no args (back-compat)", async () => {
		process.env.LIVE_MEMORY_BACKEND = "agent-memory";
		const { client, rec } = makeFakeClient();
		__setAgentMemoryClient(client);
		setActiveMemorySession("incident-analyzer", "t-bound");
		await endAgentMemorySession();
		expect(rec.ended).toEqual([{ userId: "incident-analyzer", sessionId: "t-bound" }]);
	});

	test("endAgentMemorySession swallows SESSION_ALREADY_ENDED as idempotent success (SIO-956)", async () => {
		// pagehide after Clear / re-fired beacon: the session is already ended. A
		// second end must NOT throw and must clear the ref (no warn, no crash).
		process.env.LIVE_MEMORY_BACKEND = "agent-memory";
		const client: AgentMemoryClient = {
			async ensureUser() {},
			async ensureSession() {},
			async addFacts() {},
			async addMessages() {},
			async searchMemory() {
				return [];
			},
			async updateSession() {},
			async endSession() {
				throw new SessionAlreadyEndedError("already ended");
			},
			async checkHealth() {
				return { ok: true };
			},
		};
		__setAgentMemoryClient(client);
		setActiveMemorySession("elastic-iac", "t-ended");
		// must resolve, not reject
		await endAgentMemorySession();
		expect(true).toBe(true);
	});

	test("flushAgentMemory discards (does not requeue) writes after the session ended (SIO-956)", async () => {
		// A late turn's blocks can't land on a closed session; drop them quietly
		// rather than requeue forever or noisily report 'writes dropped'.
		process.env.LIVE_MEMORY_BACKEND = "agent-memory";
		const client: AgentMemoryClient = {
			async ensureUser() {},
			async ensureSession() {},
			async addFacts() {
				throw new SessionAlreadyEndedError("already ended");
			},
			async addMessages() {
				throw new SessionAlreadyEndedError("already ended");
			},
			async searchMemory() {
				return [];
			},
			async updateSession() {},
			async endSession() {},
			async checkHealth() {
				return { ok: true };
			},
		};
		__setAgentMemoryClient(client);
		setActiveMemorySession("elastic-iac", "t-ended");
		enqueueMessage({ user_content: "q", assistant_content: "a" }, "2026-06-17T00:00:00Z");
		await flushAgentMemory();
		expect(pendingWriteCount()).toBe(0); // discarded, NOT requeued
	});

	test("clearActiveMemorySession resets the outcome so it never leaks to the next session (SIO-952)", async () => {
		process.env.LIVE_MEMORY_BACKEND = "agent-memory";
		const { client, rec } = makeFakeClient();
		__setAgentMemoryClient(client);
		setActiveMemorySession("elastic-iac", "t-1");
		setSessionOutcome("rejected");
		await endAgentMemorySession(); // ends + clears
		// New session, no outcome set -> updateSession must NOT be called.
		setActiveMemorySession("elastic-iac", "t-2");
		enqueueMessage({ user_content: "q", assistant_content: "a" }, "2026-06-17T00:00:00Z");
		await endAgentMemorySession();
		expect(rec.updated).toHaveLength(1); // only the first session stamped an outcome
	});
});

describe("annotations + metadata (SIO-952)", () => {
	test("flush stamps user metadata, session annotations, and block kind", async () => {
		process.env.LIVE_MEMORY_BACKEND = "agent-memory";
		const { client, rec } = makeFakeClient();
		__setAgentMemoryClient(client);
		setActiveMemorySession("elastic-iac", "t-iac");
		setSessionDatasources("elastic-iac");
		enqueueFact("decided to resize warm tier", "2026-06-17T00:00:00Z", { intent: "fleet-upgrade" });
		enqueueMessage({ user_content: "q", assistant_content: "a" }, "2026-06-17T00:01:00Z", undefined, {
			intent: "fleet-upgrade",
		});
		await flushAgentMemory();

		expect(rec.userMetadata[0]).toMatchObject({ agent: "elastic-iac", role: "iac-maker" });
		expect(rec.sessionAnnotations[0]).toMatchObject({ agent: "elastic-iac", datasources: "elastic-iac" });
		expect(rec.factAnnotations[0]).toMatchObject({ kind: "key-decision", intent: "fleet-upgrade" });
		expect(rec.messageAnnotations[0]).toMatchObject({ kind: "daily-log", intent: "fleet-upgrade" });
	});

	test("a 503 on flush requeues the batch instead of dropping it", async () => {
		process.env.LIVE_MEMORY_BACKEND = "agent-memory";
		setActiveMemorySession("incident-analyzer", "t-1");
		// First flush: client throws 503 -> batch requeued.
		let throwOn503 = true;
		const accepted: string[] = [];
		const client: AgentMemoryClient = {
			async ensureUser() {},
			async ensureSession() {},
			async addFacts(_ref, facts) {
				if (throwOn503) throw new ServiceUnavailableError("queue full", 5);
				accepted.push(...facts);
			},
			async addMessages() {},
			async searchMemory() {
				return [];
			},
			async updateSession() {},
			async endSession() {},
			async checkHealth() {
				return { ok: true };
			},
		};
		__setAgentMemoryClient(client);
		recordKeyDecision({ requestId: "r1", decision: "scale consumers" });
		await flushAgentMemory();
		expect(accepted).toHaveLength(0); // 503 -> nothing accepted yet
		expect(pendingWriteCount()).toBe(1); // requeued, not dropped
		// Service recovers; next flush succeeds.
		throwOn503 = false;
		await flushAgentMemory();
		expect(accepted).toEqual(["scale consumers"]);
		expect(pendingWriteCount()).toBe(0);
	});
});

// SIO-973: dedup recall hits by a stable annotation key so a re-recorded fact (durable +
// undeletable -> permanently doubled) renders once.
describe("dedupeHitsBy (SIO-973)", () => {
	const hit = (text: string, annotations: Record<string, string>) => ({ text, annotations });

	test("collapses hits sharing the same key, keeping the first (highest-ranked)", () => {
		const hits = [
			hit("US cloud upgraded to 9.3.0.", { pipeline_id: "2600000001", version: "9.3.0" }),
			hit("The US cloud was upgraded to 9.3.0 smoothly.", { pipeline_id: "2600000001", version: "9.3.0" }),
		];
		const out = dedupeHitsBy(hits, (h) => h.annotations.pipeline_id);
		expect(out).toHaveLength(1);
		expect(out.at(0)?.text).toBe("US cloud upgraded to 9.3.0.");
	});

	test("keeps genuinely distinct upgrades (different keys)", () => {
		const hits = [hit("upgraded to 9.3.0", { pipeline_id: "1" }), hit("upgraded to 9.4.2", { pipeline_id: "2" })];
		expect(dedupeHitsBy(hits, (h) => h.annotations.pipeline_id)).toHaveLength(2);
	});

	test("never collapses distinct keyless hits together", () => {
		const hits = [hit("a", {}), hit("b", {})];
		expect(dedupeHitsBy(hits, (h) => h.annotations.pipeline_id)).toHaveLength(2);
	});

	test("empty in -> empty out", () => {
		expect(dedupeHitsBy([], (h) => h.annotations.pipeline_id)).toEqual([]);
	});
});

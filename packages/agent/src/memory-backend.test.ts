// agent/src/memory-backend.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	type AgentMemoryClient,
	type AgentMemoryUserRef,
	type ChatMessageBlock,
	redactPiiContent,
	ServiceUnavailableError,
} from "@devops-agent/shared";
import {
	__resetMemoryQueue,
	__setAgentMemoryClient,
	clearActiveMemorySession,
	endAgentMemorySession,
	enqueueMessage,
	flushAgentMemory,
	flushAgentMemoryAfterTurn,
	pendingWriteCount,
	recallAgentMemory,
	resolveUserId,
	selectedBackend,
	setActiveMemorySession,
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
	sessions: string[];
	facts: string[];
	messages: ChatMessageBlock[];
	searches: string[];
	ended: AgentMemoryUserRef[];
}

function makeFakeClient(searchResult: string[] = []): { client: AgentMemoryClient; rec: Recorded } {
	const rec: Recorded = { users: [], sessions: [], facts: [], messages: [], searches: [], ended: [] };
	const client: AgentMemoryClient = {
		async ensureUser(userId) {
			rec.users.push(userId);
		},
		async ensureSession(_userId, sessionId) {
			rec.sessions.push(sessionId);
		},
		async addFacts(_ref, facts) {
			rec.facts.push(...facts);
		},
		async addMessages(_ref, messages) {
			rec.messages.push(...messages);
		},
		async searchMemory(_ref, query) {
			rec.searches.push(query);
			return searchResult.map((text) => ({ text }));
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

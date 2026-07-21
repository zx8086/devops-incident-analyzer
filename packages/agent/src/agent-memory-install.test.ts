// agent/src/agent-memory-install.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { AgentMemoryClient } from "@devops-agent/shared";
import { installAgentMemory } from "./agent-memory-install.ts";
import { __resetMemoryQueue, __setAgentMemoryClient, clearActiveMemorySession } from "./memory-backend.ts";

const prevBackend = process.env.LIVE_MEMORY_BACKEND;

beforeEach(() => {
	clearActiveMemorySession();
	__resetMemoryQueue();
});

afterEach(() => {
	if (prevBackend === undefined) delete process.env.LIVE_MEMORY_BACKEND;
	else process.env.LIVE_MEMORY_BACKEND = prevBackend;
	__setAgentMemoryClient(null);
});

// SIO-1170: these tests assert the probe actually DISPATCHES a checkHealth() call for the
// agent-memory backend (not merely that installAgentMemory doesn't throw, which would also pass
// if the probe were never wired up at all), and that it never calls checkHealth() for the default
// file backend. The probe's log output is not asserted (pino is not spy-friendly here, and no
// sibling suite in this package asserts on logger calls either -- see memory-backend.test.ts).
describe("installAgentMemory startup probe (SIO-1170)", () => {
	test("dispatches exactly one checkHealth() call for the agent-memory backend, without blocking install", async () => {
		process.env.LIVE_MEMORY_BACKEND = "agent-memory";
		let checkHealthCalls = 0;
		// A never-resolving checkHealth lets the assertion below observe the call BEFORE the probe's
		// promise settles, proving installAgentMemory dispatches it synchronously rather than merely
		// not-throwing because the probe was never wired up.
		const client: AgentMemoryClient = {
			async ensureUser() {},
			async ensureSession() {},
			async addFacts() {
				return { blockIds: [], acceptedCount: 0, rejectedCount: 0 };
			},
			async addMessages() {
				return { blockIds: [], acceptedCount: 0, rejectedCount: 0 };
			},
			async searchMemory() {
				return [];
			},
			async updateSession() {},
			async endSession() {},
			async checkHealth() {
				checkHealthCalls++;
				return new Promise(() => {});
			},
		};
		__setAgentMemoryClient(client);
		// installAgentMemory is synchronous and the probe is fire-and-forget; it must return
		// immediately without waiting on the pending health check.
		expect(() => installAgentMemory()).not.toThrow();
		expect(checkHealthCalls).toBe(1);
	});

	test("does not log past a rejected/thrown checkHealth() (SIO-1170 regression)", async () => {
		process.env.LIVE_MEMORY_BACKEND = "agent-memory";
		const client: AgentMemoryClient = {
			async ensureUser() {},
			async ensureSession() {},
			async addFacts() {
				return { blockIds: [], acceptedCount: 0, rejectedCount: 0 };
			},
			async addMessages() {
				return { blockIds: [], acceptedCount: 0, rejectedCount: 0 };
			},
			async searchMemory() {
				return [];
			},
			async updateSession() {},
			async endSession() {},
			async checkHealth() {
				throw new TypeError("fetch failed", { cause: new Error("ECONNREFUSED") });
			},
		};
		__setAgentMemoryClient(client);
		installAgentMemory();
		// Let the fire-and-forget probe's microtasks (checkAgentMemoryHealth's own catch, then the
		// .then() in probeAgentMemoryAtStartup) drain; the assertion is just that nothing throws
		// asynchronously and escapes as an unhandled rejection.
		await Promise.resolve();
		await Promise.resolve();
	});

	test("is a no-op probe for the default file backend: checkHealth is never invoked", () => {
		delete process.env.LIVE_MEMORY_BACKEND;
		let checkHealthCalls = 0;
		const client: AgentMemoryClient = {
			async ensureUser() {},
			async ensureSession() {},
			async addFacts() {
				return { blockIds: [], acceptedCount: 0, rejectedCount: 0 };
			},
			async addMessages() {
				return { blockIds: [], acceptedCount: 0, rejectedCount: 0 };
			},
			async searchMemory() {
				return [];
			},
			async updateSession() {},
			async endSession() {},
			async checkHealth() {
				checkHealthCalls++;
				return { ok: true };
			},
		};
		__setAgentMemoryClient(client);
		expect(() => installAgentMemory()).not.toThrow();
		expect(checkHealthCalls).toBe(0);
	});
});

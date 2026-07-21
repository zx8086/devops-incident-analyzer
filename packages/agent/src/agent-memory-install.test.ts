// agent/src/agent-memory-install.test.ts
//
// SIO-1170: installAgentMemory() fires an unawaited startup health probe when the backend is
// agent-memory. These tests only assert the observable, non-flaky behavior: the probe must never
// throw or block installation, and must be a no-op for the default file backend. The probe's log
// output is not asserted (pino is not spy-friendly here, and no sibling suite in this package
// asserts on logger calls either -- see memory-backend.test.ts for the established pattern).
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

describe("installAgentMemory startup probe (SIO-1170)", () => {
	test("does not throw when the agent-memory backend is unreachable at startup", () => {
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
		// installAgentMemory is synchronous and the probe is fire-and-forget; it must return
		// immediately without waiting on (or throwing from) the failed health check.
		expect(() => installAgentMemory()).not.toThrow();
	});

	test("is a no-op probe for the default file backend", () => {
		delete process.env.LIVE_MEMORY_BACKEND;
		expect(() => installAgentMemory()).not.toThrow();
	});
});

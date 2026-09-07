// agent/src/iac/local-tools.test.ts
//
// SIO-966 / SIO-967: the LOCAL durable-memory query tool. The knowledge-graph query
// tool moved to the MCP surface in SIO-967; its handler is now tested in
// packages/mcp-server-knowledge-graph/src/tools/curated.test.ts.
//
// SIO-1045: this file OWNS a mock.module("../memory-backend.ts", ...) registered at file scope,
// BEFORE the static `import "./local-tools.ts"` below (which itself statically imports
// ../memory-backend.ts). bun's mock.module is process-global and last-registration-wins; a sibling
// test file (iac-change-memory.test.ts / reconcile.test.ts) that mocks the same module and restores
// it in its own afterEach/afterAll is NOT sufficient -- the polluter-side restore was proven
// insufficient on Linux CI (bun schedules test files in a different order there than locally), so
// every VICTIM must re-claim its own dependency deterministically at its own file scope instead of
// trusting another file's cleanup. The factory below re-exports the REAL module's implementation for
// everything (so runMemorySearch's real logic + the real searchAgentMemory/selectedBackend behavior
// is exercised), with per-test control only where a test needs to observe/stub the network boundary.
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import * as realMemoryBackendNs from "../memory-backend.ts";

// SIO-1045: a namespace import (`import * as ns`) is a LIVE VIEW -- when any file registers a
// mock.module() for this path, bun live-patches every existing namespace binding, INCLUDING this
// captured `realMemoryBackendNs` object, so re-claiming with `() => realMemoryBackendNs` would
// re-register the very poison it means to undo (a circular no-op). A value snapshot (spread into a
// plain object at load time, before any mock.module() call below runs) copies the function VALUES and
// is immune to that later live-patching.
const realMemoryBackend = { ...realMemoryBackendNs };

mock.module("../memory-backend.ts", () => realMemoryBackend);

import { createSearchMemoryTool, runMemorySearch } from "./local-tools.ts";

const prevBackend = process.env.LIVE_MEMORY_BACKEND;

// SIO-1045: re-claim in beforeEach too (not just afterEach) so this file is self-claiming even if a
// sibling suite poisoned the module between this file's load and the first test's execution.
beforeEach(() => {
	mock.module("../memory-backend.ts", () => realMemoryBackend);
});

afterEach(() => {
	if (prevBackend === undefined) delete process.env.LIVE_MEMORY_BACKEND;
	else process.env.LIVE_MEMORY_BACKEND = prevBackend;
	// SIO-1045: re-claim ownership after every test in this file, in case a test body's own dynamic
	// `await import("../memory-backend.ts")` call raced a mock registered by a test running
	// concurrently in another worker, or a nested import re-registered the mock differently.
	mock.module("../memory-backend.ts", () => realMemoryBackend);
});

describe("runMemorySearch", () => {
	test("soft-fails when the backend is not agent-memory", async () => {
		delete process.env.LIVE_MEMORY_BACKEND; // file backend
		const out = await runMemorySearch("elastic-iac", { query: "eu-b2b upgrade" });
		expect(out).toContain("No matching memory");
	});

	test("renders hits with KG-key tags when the agent-memory backend returns rows", async () => {
		process.env.LIVE_MEMORY_BACKEND = "agent-memory";
		const { __setAgentMemoryClient } = await import("../memory-backend.ts");
		__setAgentMemoryClient({
			async ensureUser() {},
			async ensureSession() {},
			async addFacts() {},
			async addMessages() {},
			async searchMemory(_ref: unknown, _q: string, opts?: { annotations?: Record<string, string> }) {
				// echo the filter back so the test proves it is forwarded
				expect(opts?.annotations).toEqual({ deployment: "eu-b2b", stack: "lifecycle-policies" });
				return [
					{
						text: "Elastic IaC change proposed on eu-b2b/lifecycle-policies: metrics warm.",
						score: 0.9,
						annotations: { deployment: "eu-b2b", stack: "lifecycle-policies", outcome: "completed" },
					},
				];
			},
			async updateSession() {},
			async endSession() {},
			async checkHealth() {
				return { ok: true };
			},
			// biome-ignore lint/suspicious/noExplicitAny: SIO-966 - test stub for the AgentMemoryClient surface
		} as any);
		const out = await runMemorySearch("elastic-iac", {
			query: "metrics policy",
			deployment: "eu-b2b",
			stack: "lifecycle-policies",
		});
		expect(out).toContain("metrics warm");
		// SIO-1005: a proposal-only fact (outcome:"completed", no lifecycle) now reads "proposed", not
		// the misleading "completed" -- lifecycleTag corrects the wording at the render site.
		expect(out).toContain("[eu-b2b lifecycle-policies proposed]");
		__setAgentMemoryClient(null);
		delete process.env.LIVE_MEMORY_BACKEND;
	});

	test("SIO-1005: a reconciled fact renders its lifecycle (applied), not the outcome", async () => {
		process.env.LIVE_MEMORY_BACKEND = "agent-memory";
		const { __setAgentMemoryClient } = await import("../memory-backend.ts");
		__setAgentMemoryClient({
			async ensureUser() {},
			async ensureSession() {},
			async addFacts() {},
			async addMessages() {},
			async searchMemory() {
				return [
					{
						text: "Elastic IaC change APPLIED (live) on eu-b2b/lifecycle-policies: metrics warm.",
						score: 0.9,
						annotations: {
							deployment: "eu-b2b",
							stack: "lifecycle-policies",
							outcome: "applied",
							lifecycle: "applied",
						},
					},
				];
			},
			async updateSession() {},
			async endSession() {},
			async checkHealth() {
				return { ok: true };
			},
			// biome-ignore lint/suspicious/noExplicitAny: SIO-1005 - test stub for the AgentMemoryClient surface
		} as any);
		const out = await runMemorySearch("elastic-iac", { query: "metrics policy" });
		expect(out).toContain("[eu-b2b lifecycle-policies applied]");
		__setAgentMemoryClient(null);
		delete process.env.LIVE_MEMORY_BACKEND;
	});
});

describe("tool factories", () => {
	test("expose the documented name + zod schema", () => {
		const mem = createSearchMemoryTool("elastic-iac");
		expect(mem.name).toBe("search_memory");
		expect(mem.description.toLowerCase()).toContain("memory");
	});
});

// SIO-1664: the retrospective fleet-upgrade history tool. This exists because the durable-memory
// path structurally could not answer "what agent upgrades did we do today": the in-flight recall
// collapses to ONE upgrade, and fleet facts carry no queryable date. The KG already stores a dated
// ConfigChange per apply, so this returns a LIST bounded by `since`. Uses a stubbed graph store --
// the real-engine round trip is covered in the knowledge-graph package's integration suite.
describe("runFleetUpgradeHistory (SIO-1664)", () => {
	const rows = [
		{ deployment: "us-cld", version: "9.5.3", outcome: "applied", summary: "", createdAt: "2026-09-08T09:00:00.000Z" },
		{ deployment: "eu-cld", version: "9.5.3", outcome: "proposed", summary: "", createdAt: "2026-09-08T08:00:00.000Z" },
	];

	test("renders EVERY upgrade as its own line, never collapsing to one", async () => {
		mock.module("@devops-agent/knowledge-graph", () => ({
			isKnowledgeGraphEnabled: () => true,
			getGraphStore: async () => ({}),
			fleetUpgradeHistory: async () => rows,
		}));
		const { runFleetUpgradeHistory } = await import("./local-tools.ts");
		const out = await runFleetUpgradeHistory({ since: "2026-09-08T00:00:00.000Z" });
		const lines = out.split("\n").filter(Boolean);
		expect(lines).toHaveLength(2);
		expect(lines[0]).toContain("us-cld");
		expect(lines[0]).toContain("9.5.3");
		expect(lines[1]).toContain("eu-cld");
	});

	test("an empty window says so rather than implying nothing ever ran", async () => {
		mock.module("@devops-agent/knowledge-graph", () => ({
			isKnowledgeGraphEnabled: () => true,
			getGraphStore: async () => ({}),
			fleetUpgradeHistory: async () => [],
		}));
		const { runFleetUpgradeHistory } = await import("./local-tools.ts");
		expect(await runFleetUpgradeHistory({ since: "2027-01-01T00:00:00.000Z" })).toContain(
			"at or after 2027-01-01T00:00:00.000Z",
		);
	});

	test("soft-fails when the graph is disabled or the read throws (never errors the turn)", async () => {
		mock.module("@devops-agent/knowledge-graph", () => ({
			isKnowledgeGraphEnabled: () => false,
			getGraphStore: async () => ({}),
			fleetUpgradeHistory: async () => rows,
		}));
		const disabled = await import("./local-tools.ts");
		expect(await disabled.runFleetUpgradeHistory({})).toContain("knowledge graph is disabled");

		mock.module("@devops-agent/knowledge-graph", () => ({
			isKnowledgeGraphEnabled: () => true,
			getGraphStore: async () => {
				throw new Error("cold store");
			},
			fleetUpgradeHistory: async () => rows,
		}));
		const throwing = await import("./local-tools.ts");
		expect(await throwing.runFleetUpgradeHistory({})).toContain("unavailable");
	});
});

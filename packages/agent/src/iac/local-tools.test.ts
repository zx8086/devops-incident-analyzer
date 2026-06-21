// agent/src/iac/local-tools.test.ts
//
// SIO-966 / SIO-967: the LOCAL durable-memory query tool. The knowledge-graph query
// tool moved to the MCP surface in SIO-967; its handler is now tested in
// packages/mcp-server-knowledge-graph/src/tools/curated.test.ts.
import { afterEach, describe, expect, test } from "bun:test";
import { createSearchMemoryTool, runMemorySearch } from "./local-tools.ts";

const prevBackend = process.env.LIVE_MEMORY_BACKEND;

afterEach(() => {
	if (prevBackend === undefined) delete process.env.LIVE_MEMORY_BACKEND;
	else process.env.LIVE_MEMORY_BACKEND = prevBackend;
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

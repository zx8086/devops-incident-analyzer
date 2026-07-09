// agent/src/orchestrator-prompt-assembly.test.ts
//
// SIO-1040: byte-identity invariant for the stable/volatile split. Uses the real
// loadAgent (gitagent-bridge is NOT mocked) but never touches getAgent, so this
// suite is immune to the process-global mock.module("./prompt-context.ts") that
// sibling suites register.

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { buildSystemPrompt, loadAgent } from "@devops-agent/gitagent-bridge";
import { assembleOrchestratorPromptParts, filterAgentRunbooks } from "./orchestrator-prompt-assembly.ts";

const AGENTS_DIR = join(import.meta.dir, "../../../agents/incident-analyzer");

// Non-empty volatile sections mirroring what prompt-context renders. The exact
// text is irrelevant; the invariant is that concatenation order is preserved.
const SECTIONS = {
	compliance: "\n\n---\n\n## Compliance Boundary\n- do-thing",
	liveMemory: "\n\n---\n\n## Live Memory\nprior context",
	wiki: "\n\n---\n\n## Wiki\npage",
	graph: "\n\n---\n\n## Knowledge Graph\nprior incident",
};

// Reconstruct the pre-split single-expression prompt: buildSystemPrompt(agent)
// == core + knowledge, then the four sections appended in order.
function legacyPrompt(agent: ReturnType<typeof loadAgent>): string {
	return buildSystemPrompt(agent) + SECTIONS.compliance + SECTIONS.liveMemory + SECTIONS.wiki + SECTIONS.graph;
}

describe("assembleOrchestratorPromptParts byte-identity (SIO-1040)", () => {
	test("filter undefined: stable + volatile === legacy prompt", () => {
		const agent = loadAgent(AGENTS_DIR);
		const parts = assembleOrchestratorPromptParts(agent, SECTIONS);
		expect(parts.stable + parts.volatile).toBe(legacyPrompt(agent));
	});

	test("filter [] (suppress all runbooks): stable + volatile === legacy prompt for the filtered agent", () => {
		const agent = filterAgentRunbooks(loadAgent(AGENTS_DIR), []);
		const parts = assembleOrchestratorPromptParts(agent, SECTIONS);
		expect(parts.stable + parts.volatile).toBe(legacyPrompt(agent));
		// suppressing all runbooks drops the runbook bodies from the knowledge block
		expect(parts.volatile).not.toContain("### Runbooks");
	});

	test("filter named runbooks: stable + volatile === legacy prompt for the filtered agent", () => {
		const base = loadAgent(AGENTS_DIR);
		const firstRunbook = base.knowledge.find((k) => k.category === "runbooks")?.filename;
		expect(firstRunbook).toBeDefined();
		const agent = filterAgentRunbooks(base, [firstRunbook as string]);
		const parts = assembleOrchestratorPromptParts(agent, SECTIONS);
		expect(parts.stable + parts.volatile).toBe(legacyPrompt(agent));
		// the one kept runbook is still present
		expect(parts.volatile).toContain(firstRunbook as string);
	});

	test("stable prefix is invariant across runbook filters (the cache-hit property)", () => {
		const base = loadAgent(AGENTS_DIR);
		const firstRunbook = base.knowledge.find((k) => k.category === "runbooks")?.filename as string;
		const unfiltered = assembleOrchestratorPromptParts(base, SECTIONS);
		const suppressed = assembleOrchestratorPromptParts(filterAgentRunbooks(base, []), SECTIONS);
		const named = assembleOrchestratorPromptParts(filterAgentRunbooks(base, [firstRunbook]), SECTIONS);
		expect(suppressed.stable).toBe(unfiltered.stable);
		expect(named.stable).toBe(unfiltered.stable);
	});

	test("knowledge lives in volatile, not stable", () => {
		const parts = assembleOrchestratorPromptParts(loadAgent(AGENTS_DIR), SECTIONS);
		expect(parts.stable).not.toContain("## Knowledge Base");
		expect(parts.volatile).toContain("## Knowledge Base");
	});

	test("filterAgentRunbooks undefined is a pass-through (same knowledge identity)", () => {
		const agent = loadAgent(AGENTS_DIR);
		expect(filterAgentRunbooks(agent, undefined)).toBe(agent);
	});

	test("filterAgentRunbooks keeps non-runbook knowledge categories untouched", () => {
		const agent = loadAgent(AGENTS_DIR);
		const nonRunbook = agent.knowledge.filter((k) => k.category !== "runbooks");
		const filtered = filterAgentRunbooks(agent, []);
		const filteredNonRunbook = filtered.knowledge.filter((k) => k.category !== "runbooks");
		expect(filteredNonRunbook).toEqual(nonRunbook);
		// all runbooks removed by the empty filter
		expect(filtered.knowledge.some((k) => k.category === "runbooks")).toBe(false);
	});
});

// packages/agent/src/prompt-context.test.ts
import { describe, expect, mock, test } from "bun:test";

// SIO-640: Mock gitagent-bridge to return a synthetic agent with three
// runbooks and two non-runbook knowledge entries. Isolates filter logic
// from the real filesystem.
mock.module("@devops-agent/gitagent-bridge", () => ({
	loadAgent: () => ({
		manifest: { compliance: { risk_tier: "low" } },
		soul: "SOUL",
		rules: "RULES",
		tools: [],
		skills: new Map(),
		subAgents: new Map(),
		knowledge: [
			{ category: "runbooks", filename: "a.md", content: "# A\n\nRunbook A content" },
			{ category: "runbooks", filename: "b.md", content: "# B\n\nRunbook B content" },
			{ category: "runbooks", filename: "c.md", content: "# C\n\nRunbook C content" },
			{ category: "systems-map", filename: "deps.md", content: "# Deps" },
			{ category: "slo-policies", filename: "slo.md", content: "# SLO" },
		],
	}),
	requiresApproval: () => false,
	buildSystemPrompt: (agent: {
		soul: string;
		rules: string;
		knowledge: { category: string; filename: string; content: string }[];
	}) => {
		// Minimal reimplementation: emit knowledge entries grouped by category.
		const sections: string[] = [agent.soul, agent.rules];
		if (agent.knowledge.length > 0) {
			sections.push("## Knowledge Base");
			const byCategory = new Map<string, typeof agent.knowledge>();
			for (const entry of agent.knowledge) {
				const existing = byCategory.get(entry.category) ?? [];
				existing.push(entry);
				byCategory.set(entry.category, existing);
			}
			for (const [category, entries] of byCategory) {
				sections.push(`### ${category}`);
				for (const entry of entries) {
					sections.push(`#### ${entry.filename}\n\n${entry.content}`);
				}
			}
		}
		return sections.join("\n\n");
	},
}));

// Import AFTER mock.module so the mock is in effect.
import { buildOrchestratorPrompt } from "./prompt-context.ts";

describe("buildOrchestratorPrompt: runbookFilter", () => {
	test("undefined filter keeps all runbooks (current behavior)", () => {
		const prompt = buildOrchestratorPrompt();
		expect(prompt).toContain("a.md");
		expect(prompt).toContain("b.md");
		expect(prompt).toContain("c.md");
		expect(prompt).toContain("deps.md");
		expect(prompt).toContain("slo.md");
	});

	test("empty array suppresses all runbooks but keeps systems-map and slo-policies", () => {
		const prompt = buildOrchestratorPrompt({ runbookFilter: [] });
		expect(prompt).not.toContain("a.md");
		expect(prompt).not.toContain("b.md");
		expect(prompt).not.toContain("c.md");
		expect(prompt).toContain("deps.md");
		expect(prompt).toContain("slo.md");
	});

	test("single-entry filter keeps only that runbook", () => {
		const prompt = buildOrchestratorPrompt({ runbookFilter: ["a.md"] });
		expect(prompt).toContain("a.md");
		expect(prompt).not.toContain("b.md");
		expect(prompt).not.toContain("c.md");
		expect(prompt).toContain("deps.md");
		expect(prompt).toContain("slo.md");
	});

	test("two-entry filter keeps exactly those runbooks", () => {
		const prompt = buildOrchestratorPrompt({ runbookFilter: ["a.md", "b.md"] });
		expect(prompt).toContain("a.md");
		expect(prompt).toContain("b.md");
		expect(prompt).not.toContain("c.md");
	});

	test("nonexistent filter filters to zero runbooks", () => {
		const prompt = buildOrchestratorPrompt({ runbookFilter: ["bogus.md"] });
		expect(prompt).not.toContain("a.md");
		expect(prompt).not.toContain("b.md");
		expect(prompt).not.toContain("c.md");
		expect(prompt).toContain("deps.md");
		expect(prompt).toContain("slo.md");
	});
});

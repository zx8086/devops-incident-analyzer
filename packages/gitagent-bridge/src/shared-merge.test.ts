// gitagent-bridge/src/shared-merge.test.ts
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type LoadedAgent, loadAgent } from "./manifest-loader.ts";
import { mergeShared } from "./shared-merge.ts";
import { buildSystemPrompt } from "./skill-loader.ts";

function baseAgent(skills: Map<string, string>): LoadedAgent {
	return {
		manifest: { name: "test", version: "0.1.0", description: "test" },
		soul: "",
		rules: "",
		tools: [],
		skills,
		subAgents: new Map(),
		knowledge: [],
		workflows: new Map(),
		sharedSkills: new Map(),
	};
}

function makeSharedRoot(skills: Record<string, string>, context?: string): string {
	const root = mkdtempSync(join(tmpdir(), "gitagent-shared-"));
	mkdirSync(join(root, "skills"), { recursive: true });
	for (const [name, body] of Object.entries(skills)) {
		mkdirSync(join(root, "skills", name), { recursive: true });
		writeFileSync(join(root, "skills", name, "SKILL.md"), body);
	}
	if (context !== undefined) writeFileSync(join(root, "context.md"), context);
	return root;
}

describe("mergeShared", () => {
	test("shared-only skill is added; sharedContext is read", () => {
		const root = makeSharedRoot({ "cite-sources": "# Cite\nAlways cite." }, "# Shared\nTeam invariants.");
		try {
			const result = mergeShared(root, baseAgent(new Map()));
			expect(result.sharedSkills.has("cite-sources")).toBe(true);
			expect(result.sharedContext).toContain("Team invariants");
			expect(result.shadowedSkills).toEqual([]);
		} finally {
			rmSync(root, { recursive: true });
		}
	});

	test("local skill of the same name shadows shared (local wins)", () => {
		const root = makeSharedRoot({ "cite-sources": "# Shared version" });
		try {
			const local = new Map([["cite-sources", "# Local version"]]);
			const result = mergeShared(root, baseAgent(local));
			expect(result.sharedSkills.has("cite-sources")).toBe(false);
			expect(result.shadowedSkills).toEqual(["cite-sources"]);
		} finally {
			rmSync(root, { recursive: true });
		}
	});

	test("missing shared root yields empty merge", () => {
		const result = mergeShared(join(tmpdir(), "does-not-exist-shared-xyz"), baseAgent(new Map()));
		expect(result.sharedSkills.size).toBe(0);
		expect(result.sharedContext).toBeUndefined();
		expect(result.tools).toEqual([]);
	});
});

const AGENTS_DIR = join(import.meta.dir, "../../../agents/incident-analyzer");

describe("loadAgent: SIO-843 dynamic-pattern fields", () => {
	test("root agent exposes hooks/memory/workflows/sharedSkills fields", () => {
		const agent = loadAgent(AGENTS_DIR);
		// workflows/incident-triage.yaml exists -> parsed into the map
		expect(agent.workflows instanceof Map).toBe(true);
		expect(agent.workflows.has("incident-triage")).toBe(true);
		// SIO-845: memory/runtime/ seeded -> memory layout is loaded
		expect(agent.memory).toBeDefined();
		expect(agent.memory?.runtime.context).toContain("Live Context");
		// hooks/ not yet created in the repo -> undefined (disabled)
		expect(agent.hooks).toBeUndefined();
		// sharedSkills always present
		expect(agent.sharedSkills instanceof Map).toBe(true);
	});

	test("sub-agents leave lifecycle trees empty (root-only)", () => {
		const agent = loadAgent(AGENTS_DIR);
		const elastic = agent.subAgents.get("elastic-agent");
		expect(elastic).toBeDefined();
		expect(elastic?.hooks).toBeUndefined();
		// memory is root-only even though the root now has it
		expect(elastic?.memory).toBeUndefined();
		expect(elastic?.workflows.size).toBe(0);
		// but shared merge still runs for sub-agents
		expect(elastic?.sharedSkills instanceof Map).toBe(true);
	});
});

// SIO-844: the real agents/shared/ content (context.md + cite-sources skill)
describe("loadAgent: SIO-844 shared content flows into prompts", () => {
	test("root agent picks up the shared cite-sources skill and context", () => {
		const agent = loadAgent(AGENTS_DIR);
		expect(agent.sharedSkills.has("cite-sources")).toBe(true);
		expect(agent.sharedContext).toContain("Shared Context");
		const prompt = buildSystemPrompt(agent);
		expect(prompt).toContain("## Shared Context");
		expect(prompt).toContain("Skill: cite-sources");
		// shared context renders once
		expect(prompt.split("## Shared Context").length - 1).toBe(1);
	});

	test("sub-agents also receive the shared cite-sources skill", () => {
		const agent = loadAgent(AGENTS_DIR);
		const kafka = agent.subAgents.get("kafka-agent");
		expect(kafka?.sharedSkills.has("cite-sources")).toBe(true);
		const prompt = buildSystemPrompt(kafka as LoadedAgent);
		expect(prompt).toContain("Skill: cite-sources");
	});
});

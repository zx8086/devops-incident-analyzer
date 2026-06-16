// gitagent-bridge/src/elastic-iac-load.test.ts
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { loadAgent } from "./index.ts";

const AGENTS_ROOT = join(import.meta.dir, "../../../agents");

// GAP-dialect load: the elastic-iac agent uses the GitAgent Protocol layout
// (object-id skills/tools, scalar model.fallback, repository + segregation_of_duties,
// DUTIES.md, knowledge auto-discovery, map-form SkillsFlow workflows).
describe("loadAgent(elastic-iac) — GAP dialect", () => {
	const agent = loadAgent(join(AGENTS_ROOT, "elastic-iac"));

	test("manifest normalizes GAP shapes", () => {
		expect(agent.manifest.name).toBe("pvh-elastic-iac-agent");
		// skills/tools given as [{ id }] normalize to string[]
		expect(agent.manifest.skills).toEqual([
			"resize-tier",
			"add-ilm-policy",
			"pin-fleet-integration",
			"pre-check-gl-testing",
			"open-mr",
			"validate-cluster-state",
		]);
		expect(agent.manifest.tools).toEqual(["elastic-iac"]);
		// scalar fallback normalizes to string[]
		expect(agent.manifest.model?.fallback).toEqual(["claude-sonnet-4-6"]);
		expect(agent.manifest.repository?.project_id).toBe(71488350);
		expect(agent.manifest.compliance?.segregation_of_duties?.enforcement).toBe("strict");
	});

	test("DUTIES.md is loaded", () => {
		expect(agent.duties).toContain("DUTIES");
		expect(agent.duties.length).toBeGreaterThan(0);
	});

	test("knowledge auto-discovers files + directories without index.yaml", () => {
		const filenames = new Set(agent.knowledge.map((k) => k.filename));
		expect(filenames.has("iac-repo-map.md")).toBe(true);
		expect(filenames.has("conventions.md")).toBe(true);
		// directory entries load too
		const categories = new Set(agent.knowledge.map((k) => k.category));
		expect(categories.has("runbooks")).toBe(true);
		expect(categories.has("specs")).toBe(true);
	});

	test("GAP map-form workflows convert to canonical WorkflowDef", () => {
		expect(agent.workflows.has("tier-resize-flow")).toBe(true);
		expect(agent.workflows.has("ilm-rollout-flow")).toBe(true);
		const tierResize = agent.workflows.get("tier-resize-flow");
		expect(tierResize?.steps.length).toBeGreaterThan(0);
		// step names come from the map keys; each carries a single kind
		const names = tierResize?.steps.map((s) => s.name) ?? [];
		expect(names).toContain("validate");
		expect(names).toContain("mr");
	});

	test("single unified tool facade maps to the elastic-iac server", () => {
		expect(agent.tools.length).toBe(1);
		expect(agent.tools[0]?.name).toBe("elastic-iac");
		expect(agent.tools[0]?.tool_mapping?.mcp_server).toBe("elastic-iac");
	});
});

// Regression guard: the existing array-form agent must be unaffected by the GAP changes.
describe("loadAgent(incident-analyzer) — unchanged", () => {
	const agent = loadAgent(join(AGENTS_ROOT, "incident-analyzer"));

	test("loads with array-form skills/tools and array-form workflows", () => {
		expect(agent.manifest.name).toBe("incident-analyzer");
		expect(Array.isArray(agent.manifest.skills)).toBe(true);
		expect(agent.manifest.tools).toContain("elastic-logs");
		// incident-triage.yaml is the canonical array-form dialect
		expect(agent.workflows.has("incident-triage")).toBe(true);
		// no DUTIES.md for this agent
		expect(agent.duties).toBe("");
	});
});

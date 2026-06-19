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
			"edit-slo",
			"edit-alert-rule",
			"edit-dataview",
			"edit-cluster-default",
			"edit-space",
			"grant-security-role",
			"edit-deployment-topology",
			"edit-dashboard",
			"pre-check-gl-testing",
			"open-mr",
			"validate-cluster-state",
		]);
		expect(agent.manifest.tools).toEqual(["elastic-iac"]);
		// scalar fallback normalizes to string[]
		expect(agent.manifest.model?.fallback).toEqual(["claude-sonnet-4-6"]);
		expect(agent.manifest.repository?.project_id).toBe(82850717);
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

	// SIO-953: lifecycle hooks activate the wiki + key-decision-checkpoint steps.
	test("hooks enable load_wiki_index (bootstrap) + checkpoint_key_decisions (teardown)", () => {
		expect(agent.hooks?.bootstrap?.steps).toContain("load_live_memory");
		expect(agent.hooks?.bootstrap?.steps).toContain("load_wiki_index");
		expect(agent.hooks?.teardown?.steps).toContain("flush_daily_log");
		expect(agent.hooks?.teardown?.steps).toContain("checkpoint_key_decisions");
	});

	// SIO-953: the LLM Wiki (persistent knowledge base) is provisioned, so
	// load_wiki_index has an index to read at bootstrap.
	test("memory wiki index + seed pages are provisioned", () => {
		expect(agent.memory?.wiki.indexMd).toBeDefined();
		expect(agent.memory?.wiki.indexMd).toContain("cluster-topology");
		// the three seed pages load from memory/wiki/pages/
		expect(agent.memory?.wiki.pagePaths.length).toBeGreaterThanOrEqual(3);
		const pages = new Set(agent.memory?.wiki.pagePaths.map((p) => p.split("/").pop()));
		expect(pages.has("cluster-topology.md")).toBe(true);
		expect(pages.has("iac-repo-layout.md")).toBe(true);
		expect(pages.has("maker-checker-workflow.md")).toBe(true);
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

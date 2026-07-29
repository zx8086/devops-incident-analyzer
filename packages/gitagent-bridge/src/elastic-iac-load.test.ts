// gitagent-bridge/src/elastic-iac-load.test.ts
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { loadAgent } from "./index.ts";
import { parseRunbookFrontmatter } from "./manifest-loader.ts";

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
			"version-upgrade",
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
			"open-mr",
			"validate-cluster-state",
			"query-knowledge-graph",
		]);
		expect(agent.manifest.tools).toEqual(["elastic-iac"]);
		// scalar fallback normalizes to string[]
		expect(agent.manifest.model?.fallback).toEqual(["claude-sonnet-5"]);
		expect(agent.manifest.repository?.project_id).toBe(82850717);
		expect(agent.manifest.compliance?.segregation_of_duties?.enforcement).toBe("strict");
	});

	test("DUTIES.md is loaded", () => {
		expect(agent.duties).toContain("DUTIES");
		expect(agent.duties.length).toBeGreaterThan(0);
	});

	// SIO-953: knowledge loads via knowledge/index.yaml (Knowledge Tree), which
	// replaces the manifest auto-discovery. The foundational files were moved from
	// the knowledge/ root into reference/ and load via the `reference` category
	// (so the human-only _INDEX.md is no longer pulled into the prompt).
	test("knowledge loads via index.yaml: reference category + directory categories", () => {
		const filenames = new Set(agent.knowledge.map((k) => k.filename));
		// foundational files still load (via the `reference` category) -- not dropped
		expect(filenames.has("iac-repo-map.md")).toBe(true);
		expect(filenames.has("conventions.md")).toBe(true);
		expect(filenames.has("cluster-inventory.md")).toBe(true);
		expect(filenames.has("mr-template.md")).toBe(true);
		// directory categories load too
		const categories = new Set(agent.knowledge.map((k) => k.category));
		expect(categories.has("runbooks")).toBe(true);
		expect(categories.has("specs")).toBe(true);
		expect(categories.has("reference")).toBe(true);
		// the human-only inventory is NOT loaded (lives at the root, no category)
		expect(filenames.has("_INDEX.md")).toBe(false);
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

	// SIO-953: lifecycle hooks activate the wiki, knowledge-graph warm, and
	// key-decision-checkpoint steps. warm_knowledge_graph is a safe no-op until
	// KNOWLEDGE_GRAPH_ENABLED + lbug are turned on (see agents/elastic-iac/knowledge-graph.md).
	test("hooks enable load_wiki_index + warm_knowledge_graph (bootstrap) + checkpoint_key_decisions (teardown)", () => {
		expect(agent.hooks?.bootstrap?.steps).toContain("load_live_memory");
		expect(agent.hooks?.bootstrap?.steps).toContain("load_wiki_index");
		expect(agent.hooks?.bootstrap?.steps).toContain("warm_knowledge_graph");
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

// SIO-1282: frontmatter is stripped for EVERY knowledge category, not just runbooks.
// OKF v0.2 requires frontmatter on every non-reserved .md, and before this change an OKF
// block on a non-runbook file reached the prompt as literal YAML prose (~5 KB across
// elastic-iac's 35 non-runbook files). These pin the contract, including the deliberate
// asymmetry between the runbooks throw-path and the tolerant path for everything else.
describe("knowledge frontmatter stripping across categories (SIO-1282)", () => {
	const iac = loadAgent(join(AGENTS_ROOT, "elastic-iac"));
	const incident = loadAgent(join(AGENTS_ROOT, "incident-analyzer"));

	test("no loaded knowledge entry leaks a frontmatter block into its content", () => {
		for (const agent of [iac, incident]) {
			for (const entry of agent.knowledge) {
				expect({
					file: `${entry.category}/${entry.filename}`,
					leaks: entry.content.trimStart().startsWith("---"),
				}).toEqual({ file: `${entry.category}/${entry.filename}`, leaks: false });
			}
		}
	});

	test("converted runbooks keep their triggers and lose their frontmatter", () => {
		const runbooks = incident.knowledge.filter((k) => k.category === "runbooks");
		expect(runbooks.length).toBe(10);
		// SIO-1282 PR 2 converted all 10; 7 declare triggers (SIO-1293 made the
		// cross-cutting code-change-correlation runbook deliberately trigger-less so
		// it always survives trigger narrowing), and every body starts at its H1.
		expect(runbooks.filter((k) => k.triggers).length).toBe(7);
		for (const rb of runbooks) {
			expect(rb.content.trimStart().startsWith("#")).toBe(true);
		}
	});

	test("non-runbook categories are loaded and non-empty", () => {
		// Guards against a strip that silently eats the whole body.
		for (const category of ["reference", "playbook", "specs", "issues", "cost-plans"]) {
			const entries = iac.knowledge.filter((k) => k.category === category);
			expect(entries.length).toBeGreaterThan(0);
			for (const e of entries) expect(e.content.length).toBeGreaterThan(0);
		}
	});
});

// SIO-1282 (CodeRabbit, PR #532): the strict/tolerant split and the closing-delimiter
// contract. Both are easy to regress silently, so they are pinned directly.
describe("frontmatter delimiter and strict/tolerant split (SIO-1282)", () => {
	test("a partial line like ---not-a-delimiter is NOT a closing delimiter", () => {
		// Previously /^---\r?\n?/m matched the `---` prefix, ending the frontmatter early and
		// silently dropping the leading dashes from the body.
		expect(() => parseRunbookFrontmatter("---\ntype: Runbook\n---not-a-delimiter\n# Body\n")).toThrow();
	});

	test("a delimiter with trailing whitespace still closes the block", () => {
		expect(parseRunbookFrontmatter("---\ntype: Runbook\n---   \n# Body\n").body).toBe("# Body\n");
	});

	test("CRLF frontmatter strips without leaving a stray newline", () => {
		expect(parseRunbookFrontmatter("---\r\ntype: Runbook\r\n---\r\n# Body\r\n").body).toBe("# Body\r\n");
	});

	test("a --- line inside the BODY is left untouched", () => {
		expect(parseRunbookFrontmatter("---\ntype: Runbook\n---\n# Body\n---\nmore\n").body).toBe("# Body\n---\nmore\n");
	});
});

// SIO-1290: the OKF bundle-root index.md carries `okf_version: 0.2` -- the one place the spec
// permits frontmatter on a listing file. It sits at knowledge/, which is NOT a registered
// category, so it must never reach the prompt. Same guarantee as _INDEX.md above.
describe("OKF bundle root is never prompt-loaded (SIO-1290)", () => {
	test("index.md is absent from both agents' loaded knowledge", () => {
		for (const name of ["elastic-iac", "incident-analyzer"]) {
			const agent = loadAgent(join(AGENTS_ROOT, name));
			expect(agent.knowledge.some((k) => k.filename === "index.md")).toBe(false);
			// and no entry's body carries the marker, which would mean it leaked in some other way
			expect(agent.knowledge.some((k) => k.content.includes("okf_version"))).toBe(false);
		}
	});
});

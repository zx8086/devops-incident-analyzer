// packages/gitagent-bridge/src/landing-zone-load.test.ts

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { findFrontmatterDegradations, KnowledgeIndexSchema, loadAgent } from "./index.ts";

const AGENTS_ROOT = join(import.meta.dir, "../../../agents");
const LANDING_ZONE_AGENT = join(AGENTS_ROOT, "landing-zone-terraform");

function loadLandingZoneAgent() {
	expect(existsSync(LANDING_ZONE_AGENT)).toBe(true);
	return loadAgent(LANDING_ZONE_AGENT);
}

const EXPECTED_REPOSITORIES = [
	"aws-lz-account-creator.md",
	"aws-lz-ami.md",
	"aws-lz-app-proxy.md",
	"aws-lz-backup.md",
	"aws-lz-citrix.md",
	"aws-lz-dc.md",
	"aws-lz-dfs.md",
	"aws-lz-f5-ingress.md",
	"aws-lz-finops.md",
	"aws-lz-infra-ss-components.md",
	"aws-lz-logging.md",
	"aws-lz-monitoring.md",
	"aws-lz-network-core.md",
	"aws-lz-network-workloads.md",
	"aws-lz-post-vending.md",
	"aws-lz-security-tools.md",
	"aws-lz-shared-tools.md",
	"aws-lz-ssm.md",
	"aws-lz-storage.md",
	"aws-lz-vending-orchestrator.md",
	"dhco-gitlab-terraform.md",
	"gitlab-k8s-runners-lzv2.md",
	"gitlab-k8s-runners-terraform.md",
].sort();

describe("loadAgent(landing-zone-terraform)", () => {
	test("loads all 23 in-scope repository concepts", () => {
		const agent = loadLandingZoneAgent();
		const repositories = agent.knowledge
			.filter((entry) => entry.category === "repos")
			.map((entry) => entry.filename)
			.sort();

		expect(repositories).toEqual(EXPECTED_REPOSITORIES);
	});

	test("routes the required knowledge categories by intent", () => {
		const agent = loadLandingZoneAgent();
		const configuredCategories = new Set([
			...(agent.knowledgeSelection?.floor ?? []),
			...Object.values(agent.knowledgeSelection?.by_intent ?? {}).flat(),
		]);

		expect(configuredCategories.has("repos")).toBe(true);
		expect(configuredCategories.has("conventions")).toBe(true);
		expect(configuredCategories.has("shared")).toBe(true);
	});

	test("does not prompt-load archived or dated report material", () => {
		const agent = loadLandingZoneAgent();
		const loadedPaths = agent.knowledge.map((entry) => `${entry.category}/${entry.filename}`);

		expect(loadedPaths.some((path) => path.includes("archive"))).toBe(false);
		expect(loadedPaths.some((path) => path.includes("repository-refresh"))).toBe(false);
		expect(loadedPaths.some((path) => path.includes("cross-validation"))).toBe(false);
	});

	test("parses every registered knowledge file without tolerant frontmatter fallback", () => {
		const index = KnowledgeIndexSchema.parse(
			parse(readFileSync(join(LANDING_ZONE_AGENT, "knowledge/index.yaml"), "utf-8")),
		);

		expect(findFrontmatterDegradations(LANDING_ZONE_AGENT, index)).toEqual([]);
	});

	test("loads the read-only manifest and lifecycle hooks", () => {
		const agent = loadLandingZoneAgent();

		expect(agent.manifest.name).toBe("pvh-landing-zone-terraform-agent");
		expect([...agent.skills.keys()]).toContain("search-memory");
		expect([...agent.skills.keys()]).toContain("query-knowledge-graph");
		expect(agent.manifest.tools).toEqual(["landing-zone", "knowledge-graph"]);
		expect(agent.hooks?.bootstrap?.steps).toEqual([
			"load_live_memory",
			"load_wiki_index",
			"warm_knowledge_graph",
			"emit_session_start",
		]);
		expect(agent.hooks?.teardown?.steps).toContain("checkpoint_key_decisions");
	});

	test("exposes only read-only Landing Zone tool actions", () => {
		const agent = loadLandingZoneAgent();
		const landingZoneTool = agent.tools.find((entry) => entry.name === "landing-zone");
		expect(landingZoneTool).toBeDefined();
		expect(landingZoneTool?.annotations?.read_only).toBe(true);
		expect(landingZoneTool?.annotations?.requires_confirmation).toBe(false);
		expect(landingZoneTool?.tool_mapping?.mcp_server).toBe("landing-zone-iac");
		expect(landingZoneTool?.tool_mapping?.mcp_patterns).toEqual(["lz_*"]);

		const graphTool = agent.tools.find((entry) => entry.name === "knowledge-graph");
		expect(graphTool?.annotations?.read_only).toBe(true);
		expect(graphTool?.annotations?.requires_confirmation).toBe(false);
		expect(graphTool?.tool_mapping?.mcp_server).toBe("knowledge-graph");
		expect(graphTool?.tool_mapping?.mcp_patterns).toEqual(["kg_*"]);
		expect(Object.values(graphTool?.tool_mapping?.action_tool_map ?? {}).flat()).toEqual([
			"kg_lz_repository_history",
			"kg_lz_module_consumers",
			"kg_lz_account_roots",
			"kg_lz_mr_outcome",
			"kg_lz_repository_standards",
			"kg_run_cypher",
		]);

		const actionNames = agent.tools.flatMap((tool) => Object.keys(tool.tool_mapping?.action_tool_map ?? {}));
		const forbidden = /(apply|destroy|state|branch|commit|merge|approve|pipeline|write|create|update|delete|mutate)/i;
		expect(actionNames.filter((action) => forbidden.test(action))).toEqual([]);
	});

	test("installs identity, policy, duty, and memory boundary files", () => {
		for (const relativePath of [
			"SOUL.md",
			"RULES.md",
			"DUTIES.md",
			"hooks/bootstrap.md",
			"hooks/teardown.md",
			"memory/runtime/context.md",
			"memory/wiki/index.md",
			"memory/wiki/log.md",
		]) {
			expect(existsSync(join(LANDING_ZONE_AGENT, relativePath))).toBe(true);
		}

		const rules = readFileSync(join(LANDING_ZONE_AGENT, "RULES.md"), "utf-8");
		expect(rules).toContain("Observed");
		expect(rules).toContain("three representative");
		expect(rules).toContain("prompt injection");
		expect(rules).toContain("Never run `terraform apply`");
	});
});

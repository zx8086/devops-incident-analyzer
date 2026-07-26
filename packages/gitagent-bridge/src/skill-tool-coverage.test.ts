// gitagent-bridge/src/skill-tool-coverage.test.ts

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { loadAgent } from "./manifest-loader.ts";
import { extractSkillToolNames } from "./skill-tools.ts";
import { ToolDefinitionSchema } from "./types.ts";

// SIO-1228 canary. The runtime fix unions skill-named tools into the bound set; these
// tests keep the two sources of truth honest at build time:
//   1. a tool named in skill prose must actually exist in that datasource's action map
//      (catches typos and tools deleted from the MCP server),
//   2. the union must stay under the sub-agent tool cap, so a future skill author cannot
//      silently starve action-driven selection.
// Mirrors tool-yaml-coverage.test.ts, which pins the action map against the servers.

// Keep in sync with MAX_TOOLS_PER_AGENT in packages/agent/src/sub-agent.ts.
const MAX_TOOLS_PER_AGENT = 25;

const REPO_ROOT = new URL("../../../", import.meta.url).pathname;
const ORCHESTRATOR = join(REPO_ROOT, "agents/incident-analyzer");
const SUB_AGENTS_DIR = join(ORCHESTRATOR, "agents");
const TOOLS_DIR = join(ORCHESTRATOR, "tools");

interface DataSourceTools {
	names: Set<string>;
	// mcp_patterns with the trailing "*" stripped, e.g. "gitlab_".
	prefixes: string[];
}

// dataSourceId -> its action_tool_map names + name prefixes. Sub-agent directories hold
// only SOUL.md/agent.yaml/skills -- every tool YAML lives in the ORCHESTRATOR's tools/ --
// so this must read from there, not from the sub-agent's (always empty) agent.tools.
function toolsByDataSource(): Map<string, DataSourceTools> {
	const out = new Map<string, DataSourceTools>();
	for (const file of readdirSync(TOOLS_DIR).filter((f) => f.endsWith(".yaml"))) {
		const parsed = ToolDefinitionSchema.parse(parse(readFileSync(join(TOOLS_DIR, file), "utf8")));
		const server = parsed.tool_mapping?.mcp_server;
		const map = parsed.tool_mapping?.action_tool_map;
		if (!server || !map) continue;
		const prefixes = (parsed.tool_mapping?.mcp_patterns ?? [])
			.map((p) => p.replace(/\*$/, ""))
			.filter((p) => p.length > 0);
		out.set(server, { names: new Set(Object.values(map).flat()), prefixes });
	}
	return out;
}

// Sub-agent directory name -> its datasource id, from the same table sub-agent.ts uses.
const DATA_SOURCE_BY_AGENT: Record<string, string> = {
	"elastic-agent": "elastic",
	"kafka-agent": "kafka",
	"capella-agent": "couchbase",
	"konnect-agent": "konnect",
	"gitlab-agent": "gitlab",
	"atlassian-agent": "atlassian",
	"aws-agent": "aws",
};

const dataSourceTools = toolsByDataSource();

// Load through the ROOT agent, exactly as prompt-context's getSkillToolNames does.
// Loading a sub-agent directory standalone resolves sharedRoot to a path that does not
// exist (agents/incident-analyzer/shared), so agents/shared/skills -- which the real
// prompt DOES merge in -- would be invisible here and a bad name in a shared skill would
// sail past this canary.
const rootAgent = loadAgent(ORCHESTRATOR);

const subAgentDirs = readdirSync(SUB_AGENTS_DIR).filter((name) => {
	try {
		return statSync(join(SUB_AGENTS_DIR, name)).isDirectory();
	} catch {
		return false;
	}
});

describe("SIO-1228: skill prose cannot promise tools the datasource does not expose", () => {
	test("every sub-agent directory has a known datasource mapping", () => {
		// Guards the table above going stale when a sub-agent is added.
		for (const dir of subAgentDirs) {
			expect(DATA_SOURCE_BY_AGENT[dir]).toBeDefined();
		}
	});

	// Anti-vacuity. Without this the per-agent tests below pass trivially if extraction
	// silently returns [] -- which is exactly what happened when this file first read
	// mcp_patterns off the sub-agent (whose tools[] is always empty) instead of the
	// orchestrator. The gitlab-agent is the one with substantial tool prose.
	test("extraction is actually finding tools (gitlab-agent names several)", () => {
		const agent = rootAgent.subAgents.get("gitlab-agent");
		const ds = dataSourceTools.get("gitlab");
		expect(agent).toBeDefined();
		expect(ds).toBeDefined();
		const toolLike = extractSkillToolNames(agent!).filter((n) => ds?.prefixes.some((p) => n.startsWith(p)));
		expect(toolLike.length).toBeGreaterThanOrEqual(10);
		expect(toolLike).toContain("gitlab_get_file_content");
	});

	// Pins that shared skills are in scope here. agents/shared/skills/cite-sources names
	// elasticsearch_search; if this returns 0 the loader regressed to a sharedRoot that
	// does not resolve, and shared-skill drift would go unchecked.
	test("shared skills are merged into the sub-agent view", () => {
		const agent = rootAgent.subAgents.get("kafka-agent");
		expect(agent).toBeDefined();
		expect(agent!.sharedSkills.size).toBeGreaterThan(0);
	});

	// atlassian-agent and aws-agent have directories but are NOT in the orchestrator's
	// `agents:` map, so they run on the root agent's prompt. Pinned so the fallback below
	// is a deliberate model of production, not an accident.
	test("undeclared sub-agent directories fall back to the root agent", () => {
		expect(rootAgent.subAgents.get("atlassian-agent")).toBeUndefined();
		expect(rootAgent.subAgents.get("aws-agent")).toBeUndefined();
		expect(rootAgent.subAgents.get("gitlab-agent")).toBeDefined();
	});

	for (const dir of subAgentDirs) {
		const dataSourceId = DATA_SOURCE_BY_AGENT[dir];
		if (!dataSourceId) continue;

		// Same fallback as buildSubAgentPrompt / getSkillToolNames.
		const agent = rootAgent.subAgents.get(dir) ?? rootAgent;
		const named = extractSkillToolNames(agent);
		const ds = dataSourceTools.get(dataSourceId);

		// Only tokens that LOOK like a tool for this datasource are checked -- the
		// extractor deliberately over-matches prose identifiers (`project_id`), which are
		// inert at runtime and must not fail the build.
		const toolLike = ds ? named.filter((n) => ds.prefixes.some((p) => n.startsWith(p))) : [];

		test(`${dir}: every tool-like name in skill prose exists in the action map`, () => {
			expect(ds).toBeDefined();
			const missing = toolLike.filter((n) => !ds?.names.has(n));
			expect(missing).toEqual([]);
		});

		test(`${dir}: skill-promised tools fit inside the sub-agent tool budget`, () => {
			expect(toolLike.length).toBeLessThanOrEqual(MAX_TOOLS_PER_AGENT);
		});
	}
});

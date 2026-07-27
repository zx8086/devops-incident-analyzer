// gitagent-bridge/src/skill-tool-coverage.test.ts

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { loadAgent } from "./manifest-loader.ts";
import { extractPromptToolNames, extractSkillToolNames } from "./skill-tools.ts";
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

// SIO-1234: prompt prose may name at most (budget - reserved action slots) tools, mirroring
// composeBoundTools' MIN_ACTION_TOOLS = 8. Naming more than this guarantees that either a
// promised tool goes unbound or the action-selected tools are starved -- the two failure modes
// this ticket exists to prevent.
const MIN_ACTION_TOOLS = 8;
const PROMPT_TOOL_BUDGET = MAX_TOOLS_PER_AGENT - MIN_ACTION_TOOLS;

// Ratchet entries for prose that already exceeds the budget. These numbers may only ever
// DECREASE -- lower one when prose is trimmed, and delete the entry once it reaches
// PROMPT_TOOL_BUDGET. Do NOT raise one to make a build green; that is the regression.
//
// aws-agent: RULES.md is 32.7KB and prescribes per-service protocol chains by name. Trimming it
// to conditional phrasing is tracked as the SIO-1234 follow-up; until then composeBoundTools'
// reserved action quota is what keeps the binding safe.
const KNOWN_OVERSUBSCRIBED: Readonly<Record<string, number>> = {
	"aws-agent": 62,
	// SIO-1238 removed the gitlab-agent entry (was 18, now 16). project-resolution's STEP 1 had
	// named five project-scoped tools as EXAMPLES of a universal rule, which cost budget and was
	// also a latent correctness bug: a partial list invites the model to read it as exhaustive
	// and skip resolution for a bound tool that was not on it. STEP 1 now states the rule
	// categorically ("any tool that takes a project_id argument") and points at the tool schema
	// rather than a remembered list. The Orbit exemption list below it is deliberately UNCHANGED
	// -- that one is a closed set defining an exception, so it is only actionable if every exempt
	// tool is named.
};

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

// SIO-1234 (CodeRabbit on PR #485): a name belonging to ANOTHER datasource is dropped by the
// per-datasource prefix filter below, so it escapes both checks -- yet at runtime it is exactly
// the `Tool "X" not found` this ticket exists to prevent, since a sub-agent is bound only to its
// own MCP server.
//
// Checked against the agent's OWN prose only (SOUL/RULES/duties/local skills), NOT shared bodies.
// A blanket union filter fails 6 of the 7 agents on `elasticsearch_search`, which comes from the
// SHARED cite-sources skill that is deliberately merged into every sub-agent (see the
// "shared skills are merged" test below) -- a citation example, not a call instruction.
const ALL_TOOL_PREFIXES = [...dataSourceTools.values()].flatMap(({ prefixes }) => prefixes);

// Detected instances awaiting a product decision, same ratchet discipline as
// KNOWN_OVERSUBSCRIBED: entries may be removed, never added without a linked follow-up.
//
// EMPTY as of SIO-1237, and that is the intended steady state -- adding an entry here means
// shipping a prompt that instructs a call which cannot succeed. The one historical entry was
// kafka-agent's SIO-717 "Synthetic-Monitor Cross-Check", whose step 2 told the kafka sub-agent
// to `elasticsearch_search` the synthetics-* index. That tool is bound only to elastic-agent,
// so the step could never execute. SIO-1237 moved the procedure onto the
// infra-service-degraded-needs-synthetic-cross-check rule's fetchDirective (rules.ts), which
// delivers it to elastic-agent -- the agent that owns the tool -- on the turn the rule fires.
const KNOWN_CROSS_DATASOURCE_PROSE: Readonly<Record<string, readonly string[]>> = {};

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

	// SIO-1237: the counterpart to the cross-datasource rule below. Removing the kafka SOUL's
	// unrunnable elasticsearch_search only helps if the agent it moved TO can actually run it.
	// The synthetic cross-check's fetchDirective (correlation/rules.ts) instructs elastic-agent
	// to call elasticsearch_search, and that call is guaranteed to bind ONLY because the tool is
	// named in elastic-agent's prompt: extractSkillToolNames feeds withSkillPromisedTools /
	// requiredHeadTools, which force-includes it at the head of the bound set on every turn.
	// There is no `elastic` entry in RESOLUTION_TOOLS_BY_DATASOURCE, so this prose mention is
	// the whole guarantee -- today it comes from the shared cite-sources skill. If that mention
	// is ever dropped, binding falls back to action selection alone and a correlation fetch on a
	// turn that did not pick the `search` action would re-create the exact
	// `Tool "X" not found` failure SIO-1234 exists to prevent, silently.
	test("elastic-agent's prompt names elasticsearch_search, so the cross-check directive can bind", () => {
		const agent = rootAgent.subAgents.get("elastic-agent");
		expect(agent).toBeDefined();
		const promised = agent ? extractSkillToolNames(agent) : [];
		expect(promised).toContain("elasticsearch_search");
	});

	// A sub-agent directory that is not declared in the orchestrator's `agents:` map is
	// absent from subAgents, and buildSubAgentPrompt then falls back to the root agent's
	// prompt -- so the root agent's skills are what gets promised. getSkillToolNames
	// mirrors that fallback, and this asserts the mirror is faithful for whichever
	// directories are undeclared.
	//
	// Deliberately state-agnostic: SIO-1229 declares atlassian-agent / aws-agent, after
	// which this list is empty and the check is a no-op. Asserting WHICH agents are
	// undeclared would pin a bug as permanent truth and break when that fix lands.
	test("undeclared sub-agent directories resolve to the root agent", () => {
		const undeclared = subAgentDirs.filter((d) => !rootAgent.subAgents.has(d));
		for (const dir of undeclared) {
			expect(rootAgent.subAgents.get(dir) ?? rootAgent).toBe(rootAgent);
		}
		// Declared ones must resolve to their own agent, not the root.
		const declared = subAgentDirs.filter((d) => rootAgent.subAgents.has(d));
		expect(declared.length).toBeGreaterThan(0);
		for (const dir of declared) {
			expect(rootAgent.subAgents.get(dir)).not.toBe(rootAgent);
		}
	});

	for (const dir of subAgentDirs) {
		const dataSourceId = DATA_SOURCE_BY_AGENT[dir];
		if (!dataSourceId) continue;

		// Same fallback as buildSubAgentPrompt / getSkillToolNames.
		const agent = rootAgent.subAgents.get(dir) ?? rootAgent;
		// SIO-1234: extractPromptToolNames, not extractSkillToolNames. The prompt is SOUL +
		// sharedContext + RULES + duties + skills, but this canary only ever scanned skills --
		// which is why aws-agent's 32.7KB RULES.md naming 62 tools went unnoticed until the
		// model started calling them. aws-agent declares no `skills:` block at all, so the old
		// scan saw literally nothing for it.
		const named = extractPromptToolNames(agent);
		const ds = dataSourceTools.get(dataSourceId);

		// Only tokens that LOOK like a tool for this datasource are checked -- the
		// extractor deliberately over-matches prose identifiers (`project_id`), which are
		// inert at runtime and must not fail the build.
		const toolLike = ds ? named.filter((n) => ds.prefixes.some((p) => n.startsWith(p))) : [];

		test(`${dir}: every tool-like name in prompt prose exists in the action map`, () => {
			expect(ds).toBeDefined();
			const missing = toolLike.filter((n) => !ds?.names.has(n));
			expect(missing).toEqual([]);
		});

		test(`${dir}: own prose does not name another datasource's tools`, () => {
			// sharedSkills/sharedContext excluded deliberately -- see KNOWN_CROSS_DATASOURCE_PROSE.
			const own = extractPromptToolNames({
				skills: agent.skills,
				sharedSkills: new Map(),
				soul: agent.soul,
				rules: agent.rules,
				duties: agent.duties,
			});
			const mine = ds?.prefixes ?? [];
			const foreign = own.filter(
				(n) => !mine.some((p) => n.startsWith(p)) && ALL_TOOL_PREFIXES.some((p) => n.startsWith(p)),
			);
			expect(foreign).toEqual([...(KNOWN_CROSS_DATASOURCE_PROSE[dir] ?? [])]);
		});

		test(`${dir}: prompt-promised tools fit inside the sub-agent tool budget`, () => {
			const ceiling = KNOWN_OVERSUBSCRIBED[dir] ?? PROMPT_TOOL_BUDGET;
			// RATCHET, not a wall. A hard failure here would block every unrelated PR behind a
			// 32KB prose rewrite of aws-agent/RULES.md. Instead the known-bad number may only
			// ever go DOWN: prose that names more tools than before fails, prose that names
			// fewer passes and should have its entry lowered (or deleted at <= the budget).
			expect(toolLike.length).toBeLessThanOrEqual(ceiling);
		});
	}
});

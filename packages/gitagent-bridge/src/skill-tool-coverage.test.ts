// gitagent-bridge/src/skill-tool-coverage.test.ts

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { loadAgent } from "./manifest-loader.ts";
import { buildSubAgentSystemPrompt, buildSystemPrompt, SUB_AGENT_NON_INTERACTIVE_PREAMBLE } from "./skill-loader.ts";
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

// SIO-1257: a sub-agent has no human to answer it. sub-agent.ts hands it the RAW end-user
// HumanMessage as its only message, so every "the user" in SOUL/RULES reads as a live
// interlocutor -- and nothing in the prompt said otherwise. In run
// cbada913-d22f-4618-826b-0c4c38fd8956 kafka-agent returned messageCount 2 (system + one AI
// reply), ZERO tool calls in 6.9s with 25 tools bound, and a report that "offered to check
// Couchbase sink-connector consumer groups and DLQ topics but deferred pending direction."
// There was no one to defer to, so the evidence was simply never gathered.
//
// `bun run yaml:check` is `yamllint agents/` and cannot see .md files at all, so these tests are
// the ONLY build-time guard on this prose.
//
// SCOPED TO SUB-AGENT DIRECTORIES. agents/incident-analyzer/SOUL.md legitimately says "When the
// user asks about infrastructure health ... immediately dispatch sub-agents" -- the orchestrator
// IS the turn with a human on the other end, and banning it there would be wrong.
interface ProsePattern {
	readonly name: string;
	readonly re: RegExp;
}

const HUMAN_IN_THE_LOOP_PATTERNS: readonly ProsePattern[] = [
	// "the user query references" / "the user mentions" / "the user names" / "the user asked".
	// No trailing \b on the verb stem so mention/mentions/mentioned all match.
	{
		name: "user-gated instruction",
		re: /\bthe user(?:'s)?(?:\s+(?:query|message|request|prompt))?\s+(?:mention|name|ask|reference|say|request|want|specif)/i,
	},
	{ name: "offer a follow-up", re: /\boffers?\s+(?:to\b|one\b|a\s+follow)/i },
	{
		name: "await a human",
		re: /\b(?:wait|waits|waiting|await|awaits|awaiting)\s+(?:for\s+)?(?:confirmation|approval|direction|the\s+user)\b/i,
	},
	{
		name: "conversational hand-back",
		re: /\b(?:would you like|shall i\b|let me know|pending\s+(?:direction|confirmation|approval))/i,
	},
];

// agents/shared/ merges into every sub-agent, so it carries the stricter set: shared prose must
// not even IMPLY that a confirmation channel exists. Applied ONLY to agents/shared -- the
// orchestrator's approval invariant is carried independently by buildComplianceBoundary()
// (packages/agent/src/prompt-context.ts), built from agent.yaml annotations, so nothing is lost.
const SHARED_PROSE_PATTERNS: readonly ProsePattern[] = [
	...HUMAN_IN_THE_LOOP_PATTERNS,
	{ name: "implies a confirmation channel", re: /\b(?:human-in-the-loop|user confirmation)\b/i },
];

// Same ratchet discipline as KNOWN_CROSS_DATASOURCE_PROSE: entries may be REMOVED, never added
// without a linked follow-up. Empty is the intended steady state -- an entry here means shipping
// a sub-agent prompt that tells it to wait for someone who does not exist. Keyed by
// "<source> [<pattern name>]" rather than by line number, so unrelated edits above the offending
// line do not churn this table.
const KNOWN_HUMAN_IN_THE_LOOP_PROSE: Readonly<Record<string, readonly string[]>> = {};

interface ProseBody {
	source: string;
	body: string;
}

function promptBodies(agent: {
	soul: string;
	rules: string;
	duties?: string;
	skills: Map<string, string>;
}): ProseBody[] {
	const out: ProseBody[] = [
		{ source: "SOUL.md", body: agent.soul },
		{ source: "RULES.md", body: agent.rules },
		{ source: "DUTIES.md", body: agent.duties ?? "" },
	];
	// Local skills only. sharedSkills/sharedContext get their own test below, so a shared
	// offender is reported once instead of seven times.
	for (const [name, body] of agent.skills) out.push({ source: `skills/${name}/SKILL.md`, body });
	return out.filter((s) => s.body.trim().length > 0);
}

function findDeferralProse(bodies: readonly ProseBody[], patterns: readonly ProsePattern[]): string[] {
	const hits = new Set<string>();
	for (const { source, body } of bodies) {
		for (const line of body.split("\n")) {
			// Patterns are intentionally non-global: RegExp.test on a /g regex is stateful via
			// lastIndex and would skip every other match.
			for (const { name, re } of patterns) if (re.test(line)) hits.add(`${source} [${name}]`);
		}
	}
	return [...hits].sort();
}

describe("SIO-1257: sub-agent prose never defers to a human", () => {
	for (const dir of subAgentDirs) {
		const agent = rootAgent.subAgents.get(dir);
		// An UNDECLARED directory runs the ROOT agent's prompt, which is user-facing by design.
		// Scanning it here would fail on the orchestrator's legitimate prose and mask the real
		// bug, which the "undeclared sub-agent directories resolve to the root agent" test owns.
		if (!agent) continue;

		test(`${dir}: prompt prose never gates on, offers to, or awaits a human`, () => {
			const hits = findDeferralProse(promptBodies(agent), HUMAN_IN_THE_LOOP_PATTERNS);
			expect(hits).toEqual([...(KNOWN_HUMAN_IN_THE_LOOP_PROSE[dir] ?? [])]);
		});
	}

	test("agents/shared prose never implies a confirmation channel", () => {
		const bodies: ProseBody[] = [{ source: "shared/context.md", body: rootAgent.sharedContext ?? "" }];
		for (const [name, body] of rootAgent.sharedSkills) {
			bodies.push({ source: `shared/skills/${name}/SKILL.md`, body });
		}
		expect(findDeferralProse(bodies, SHARED_PROSE_PATTERNS)).toEqual([]);
	});

	// Anti-vacuity, mirroring the SIO-1228 "extraction actually finds tools" guard. If the scanner
	// silently reads empty bodies, every test above passes trivially.
	test("the scanner actually sees prose (kafka-agent has SOUL + RULES)", () => {
		const agent = rootAgent.subAgents.get("kafka-agent");
		expect(agent).toBeDefined();
		if (!agent) return;
		const sources = promptBodies(agent).map((b) => b.source);
		expect(sources).toContain("SOUL.md");
		expect(sources).toContain("RULES.md");
	});

	// Anti-vacuity for the PATTERNS themselves: a regex typo would make every ban silently inert.
	// These are the verbatim lines that motivated the ticket.
	test("the ban patterns match their motivating strings", () => {
		const samples = [
			"When the user query references cluster health, multiple Confluent components,",
			"When the user mentions **dead-letter queues, DLQ, dead letter, or DLQ growth**,",
			"When the user names a specific service or resource:",
			'<window>" and offer to broaden, then STOP. Do NOT silently narrow',
			'   <window>") and offer ONE follow-up ("want me to broaden to `now-7d` / no',
			'   score filter?"). Wait for confirmation before re-calling -- do not',
		];
		for (const s of samples) {
			expect(HUMAN_IN_THE_LOOP_PATTERNS.some((p) => p.re.test(s))).toBe(true);
		}
	});

	// The false-positive floor. Every one of these is legitimate prose that lives in these files
	// today, and a careless widening of the patterns above would start failing on them:
	//   - "the user/operator action is ..." names a remediation OWNER, not a conversational partner
	//   - "confirm with `capella_...`" / "confirmed by a direct query" -- `confirm` as an EVIDENCE
	//     verb, not a handshake
	//   - "Defer trace-chain questions to the elastic datasource" -- cross-datasource delegation,
	//     which is how a sub-agent CORRECTLY hands work to a peer
	//   - "rather than waiting for an alarm dimension" -- the await pattern enumerates its objects
	//     precisely so this does not match
	test("the ban patterns do not fire on legitimate prose", () => {
		const legit: string[] = [
			'- `iam-permission-missing`: the action is listed; the user/operator action is "Update ..."',
			"   non-covering indexes -- confirm with `capella_get_non_covering_index_queries`",
			"- Tracing: NOT via X-Ray in these estates ... Defer trace-chain questions to the elastic datasource;",
			"fallback defers to it). Act on the kind:",
			"RDS inventory up front rather than waiting for an alarm dimension to point at it --",
			"The incident narrative or user question asks what's anomalous, whether anything",
			"output, enumerate every PAUSED / FAILED / EMPTY / DEAD entry. Do not stop at the first",
			"  An empty result set IS proof the mapping is absent (report it as confirmed by a direct",
		];
		for (const s of legit) {
			expect(HUMAN_IN_THE_LOOP_PATTERNS.some((p) => p.re.test(s))).toBe(false);
		}
	});
});

// SIO-1257 + SIO-1229: the preamble is only worth writing if it actually reaches the model. The
// SIO-1229 failure mode -- a sub-agent directory that is not declared in the orchestrator's
// `agents:` map silently runs the ROOT prompt -- would drop it just as silently, so assert
// delivery rather than assuming it.
describe("SIO-1257: the non-interactive preamble reaches every sub-agent prompt", () => {
	test("every declared sub-agent's assembled prompt opens with the preamble", () => {
		const declared = subAgentDirs.filter((d) => rootAgent.subAgents.has(d));
		// SIO-1229 regression canary: every directory on disk must be declared, or the rest of
		// this test would silently skip the undeclared one.
		expect(declared).toEqual(subAgentDirs);

		for (const dir of declared) {
			const agent = rootAgent.subAgents.get(dir);
			expect(agent).toBeDefined();
			if (!agent) continue;
			const prompt = buildSubAgentSystemPrompt(agent);
			expect(prompt.startsWith(SUB_AGENT_NON_INTERACTIVE_PREAMBLE)).toBe(true);
			// ...and the agent's OWN identity still follows it: the preamble prepends, never replaces.
			expect(prompt).toContain(agent.soul.trim().slice(0, 60));
		}
	});

	// Mirrors buildSubAgentPrompt's fallback: an undeclared directory resolves to the root agent,
	// and that path must still carry the preamble -- it is the misconfiguration case, i.e. the one
	// most likely to be dispatched with the wrong prompt.
	test("the root-agent fallback also carries the preamble", () => {
		expect(buildSubAgentSystemPrompt(rootAgent).startsWith(SUB_AGENT_NON_INTERACTIVE_PREAMBLE)).toBe(true);
	});

	// The orchestrator DOES have a human on the other end. buildSystemPrompt must stay untouched,
	// or the orchestrator would start refusing to ask the clarifying questions its SOUL allows.
	test("the orchestrator prompt does not carry the sub-agent preamble", () => {
		expect(buildSystemPrompt(rootAgent)).not.toContain(SUB_AGENT_NON_INTERACTIVE_PREAMBLE);
	});

	// The preamble must never charge against PROMPT_TOOL_BUDGET -- gitlab-agent has exactly one
	// slot of headroom (16 of 17), so a single backticked snake_case token here would eat it.
	test("the preamble names no backticked tool token", () => {
		expect(SUB_AGENT_NON_INTERACTIVE_PREAMBLE).not.toMatch(/`[a-z][a-z0-9]*(?:_[a-z0-9]+)+`/);
	});

	// It is a system-prompt contract, not a suggestion: pin the load-bearing clauses so a future
	// reword cannot quietly drop the part that actually fixes the defect.
	test("the preamble states the three load-bearing rules", () => {
		expect(SUB_AGENT_NON_INTERACTIVE_PREAMBLE).toContain("There is no human in this");
		expect(SUB_AGENT_NON_INTERACTIVE_PREAMBLE).toContain("at least one of the tools bound this turn");
		expect(SUB_AGENT_NON_INTERACTIVE_PREAMBLE).toContain("CONCLUSIONS");
	});
});

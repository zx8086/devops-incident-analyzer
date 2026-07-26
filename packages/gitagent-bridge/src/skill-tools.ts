// gitagent-bridge/src/skill-tools.ts

// SIO-1228: skill prose names the tools it tells the model to call, but action-driven
// tool selection binds only a subset. On a turn that did not select the matching action
// group the model follows its instructions, calls an unbound tool, gets
// `Tool "X" not found`, and burns ReAct iterations to the recursion limit.
// Extracting the promised names here lets the bind site union them in, so the prompt
// and the tool set cannot disagree by construction.

// Tool names are consistently backticked snake_case in skill prose. Deliberately
// over-matching: prose identifiers like `project_id` are picked up too. Validation is
// NOT done here -- the bind site intersects with the tools that actually exist, so a
// name that is not a real tool is inert (the same "stale names are harmless" property
// action-tool-maps.md documents for the action map).
//
// Limitation: a tool named WITHOUT backticks is not detected. Every skill in the repo
// backticks tool names today, and skill-tool-coverage.test.ts pins that the names which
// ARE detected resolve to real tools -- but an unbackticked mention would still diverge.
const TOOL_TOKEN = /`([a-z][a-z0-9]*(?:_[a-z0-9]+)+)`/g;

// Structural subset of LoadedAgent -- keeps this pure and testable without building a
// whole manifest. LoadedAgent satisfies it structurally.
//
// SIO-1234: widened with the four non-skill prompt bodies. They are optional so every
// existing caller (and every test fixture that supplies only the two maps) still satisfies
// the interface; only extractPromptToolNames reads them.
export interface SkillSource {
	skills: Map<string, string>;
	sharedSkills: Map<string, string>;
	soul?: string;
	rules?: string;
	duties?: string;
	sharedContext?: string;
}

function collectFrom(body: string | undefined, into: Set<string>): void {
	if (!body) return;
	// Drop frontmatter exactly like renderSkill() does, so metadata keys never read as tools.
	const bodyOnly = body.replace(/^---[\s\S]*?---\s*/m, "");
	for (const match of bodyOnly.matchAll(TOOL_TOKEN)) {
		const name = match[1];
		if (name) into.add(name);
	}
}

// Walks local then shared skills under the SAME active/shadow rules as
// buildSystemPromptParts -- a local skill shadows a shared one of the same name, so only
// the body that actually reaches the prompt contributes its tool names.
export function extractSkillToolNames(agent: SkillSource, activeSkills?: string[]): string[] {
	const names = new Set<string>();

	const localNames = activeSkills ?? [...agent.skills.keys()];
	for (const name of localNames) {
		collectFrom(agent.skills.get(name), names);
	}

	const sharedNames = activeSkills ?? [...agent.sharedSkills.keys()];
	for (const name of sharedNames) {
		if (agent.skills.has(name)) continue;
		collectFrom(agent.sharedSkills.get(name), names);
	}

	return [...names].sort();
}

// SIO-1234: every tool name the SYSTEM PROMPT names -- skills plus the four bodies
// buildSystemPromptParts also concatenates (soul, sharedContext, rules, duties).
//
// This exists for the build-time CANARY, deliberately NOT for the bind path. Widening
// extractSkillToolNames (which feeds withSkillPromisedTools) to cover RULES.md would
// prepend 62 tools for aws-agent; the 25-tool slice would then keep 25 prepended names and
// ZERO action-selected ones, and *which* 25 survived would be decided by MCP enumeration
// order rather than by relevance to the query. The binding fix is composeBoundTools'
// reserved action quota in sub-agent.ts; this function only measures the disagreement.
//
// aws-agent is the case that motivated this: it declares no `skills:` block at all, so
// extractSkillToolNames returns [] for it while its 32.7KB RULES.md names 62 tools.
export function extractPromptToolNames(agent: SkillSource, activeSkills?: string[]): string[] {
	const names = new Set(extractSkillToolNames(agent, activeSkills));
	// Order matches buildSystemPromptParts; irrelevant to a Set, but keeps the two readable
	// side by side when checking that nothing in the prompt is missed.
	collectFrom(agent.soul, names);
	collectFrom(agent.sharedContext, names);
	collectFrom(agent.rules, names);
	collectFrom(agent.duties, names);
	return [...names].sort();
}

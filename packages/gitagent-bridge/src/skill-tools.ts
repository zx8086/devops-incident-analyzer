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
export interface SkillSource {
	skills: Map<string, string>;
	sharedSkills: Map<string, string>;
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

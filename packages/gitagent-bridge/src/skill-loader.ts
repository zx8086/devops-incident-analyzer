// gitagent-bridge/src/skill-loader.ts
import type { KnowledgeEntry, LoadedAgent } from "./manifest-loader.ts";

function buildKnowledgeSection(knowledge: KnowledgeEntry[]): string {
	const byCategory = new Map<string, KnowledgeEntry[]>();
	for (const entry of knowledge) {
		const existing = byCategory.get(entry.category) ?? [];
		existing.push(entry);
		byCategory.set(entry.category, existing);
	}

	const sections: string[] = ["## Knowledge Base"];
	for (const [category, entries] of byCategory) {
		const heading = category
			.split("-")
			.map((w) => w.charAt(0).toUpperCase() + w.slice(1))
			.join(" ");
		sections.push(`### ${heading}`);
		for (const entry of entries) {
			sections.push(`#### ${entry.filename}\n\n${entry.content}`);
		}
	}

	return sections.join("\n\n");
}

function renderSkill(name: string, content: string | undefined): string | undefined {
	if (!content) return undefined;
	const bodyOnly = content.replace(/^---[\s\S]*?---\s*/m, "").trim();
	if (!bodyOnly) return undefined;
	return `## Skill: ${name}\n\n${bodyOnly}`;
}

// SIO-1014: a compact "## Skills" index (name + one-line description) so the model
// sees which skills exist at a glance, mirroring how tools expose action
// descriptions. Skipped for skills with no description (markdown-only authoring).
// Respects the same active/shadow rules as the body rendering below.
function buildSkillsCatalog(agent: LoadedAgent, activeSkills?: string[]): string | undefined {
	const lines: string[] = [];
	const seen = new Set<string>();

	const localNames = activeSkills ?? [...agent.skills.keys()];
	for (const name of localNames) {
		// SIO-1014: only mark REAL local skills as seen. A shared-only name passed
		// via activeSkills must fall through to the shared pass below, not be
		// pre-marked here (which would drop its catalog line while the body renders).
		if (!agent.skills.has(name) || seen.has(name)) continue;
		const description = agent.skillMeta.get(name)?.description?.trim();
		if (description) lines.push(`- **${name}**: ${description}`);
		seen.add(name);
	}

	const sharedNames = activeSkills ?? [...agent.sharedSkills.keys()];
	for (const name of sharedNames) {
		if (!agent.sharedSkills.has(name) || agent.skills.has(name) || seen.has(name)) continue;
		const description = agent.sharedSkillMeta.get(name)?.description?.trim();
		if (description) lines.push(`- **${name}**: ${description}`);
		seen.add(name);
	}

	if (lines.length === 0) return undefined;
	return `## Skills\n\n${lines.join("\n")}`;
}

// SIO-1040: stable/volatile split for Bedrock prompt caching. `core` is the
// identity+rules+skills prefix (stable across turns -> cacheable); `knowledge`
// is the knowledge-base section prefixed with the section separator, or "" when
// the agent has no knowledge. buildSystemPrompt = core + knowledge is
// BYTE-IDENTICAL to the pre-split output (invariant test in index.test.ts).
export interface SystemPromptParts {
	core: string;
	knowledge: string;
}

export function buildSystemPromptParts(agent: LoadedAgent, activeSkills?: string[]): SystemPromptParts {
	const sections: string[] = [];

	if (agent.soul) {
		sections.push(agent.soul.trim());
	}

	// SIO-843 / EPIC 5: monorepo-shared context applies to every agent. Placed
	// after SOUL (identity) and before RULES so shared invariants frame the
	// agent-specific rules that follow.
	if (agent.sharedContext?.trim()) {
		sections.push(`## Shared Context\n\n${agent.sharedContext.trim()}`);
	}

	if (agent.rules) {
		sections.push(agent.rules.trim());
	}

	// GAP dialect: role-boundary / separation-of-duties policy follows the rules.
	if (agent.duties?.trim()) {
		sections.push(agent.duties.trim());
	}

	// SIO-1014: the Skills catalog (name + description) frames the detailed skill
	// bodies that follow. Absent when no active skill declares a description.
	const catalog = buildSkillsCatalog(agent, activeSkills);
	if (catalog) sections.push(catalog);

	const skillsToLoad = activeSkills ?? [...agent.skills.keys()];
	for (const skillName of skillsToLoad) {
		const rendered = renderSkill(skillName, agent.skills.get(skillName));
		if (rendered) sections.push(rendered);
	}

	// SIO-843 / EPIC 5: shared skills fill gaps; mergeShared already dropped any
	// shadowed by a local skill of the same name. When activeSkills filters the
	// local set, shared skills are included only if explicitly named.
	const sharedToLoad = activeSkills ?? [...agent.sharedSkills.keys()];
	for (const skillName of sharedToLoad) {
		if (agent.skills.has(skillName)) continue;
		const rendered = renderSkill(skillName, agent.sharedSkills.get(skillName));
		if (rendered) sections.push(rendered);
	}

	const core = sections.join("\n\n---\n\n");

	// Knowledge carries the leading separator so core + knowledge reproduces the
	// original single join exactly. Empty (no separator) when there is no knowledge.
	const knowledge = agent.knowledge.length > 0 ? `\n\n---\n\n${buildKnowledgeSection(agent.knowledge)}` : "";

	return { core, knowledge };
}

export function buildSystemPrompt(agent: LoadedAgent, activeSkills?: string[]): string {
	const { core, knowledge } = buildSystemPromptParts(agent, activeSkills);
	return core + knowledge;
}

// SIO-1257: a sub-agent has no human on the other end of the turn. sub-agent.ts dispatches it with
// the RAW end-user HumanMessage as its only message, so every "the user" in SOUL/RULES reads as a
// live interlocutor -- and nothing in the assembled prompt said otherwise. In run
// cbada913-d22f-4618-826b-0c4c38fd8956 kafka-agent returned messageCount 2 (system + one AI reply),
// ZERO tool calls in 6.9s with 25 tools bound, and a report that "offered to check Couchbase
// sink-connector consumer groups and DLQ topics but deferred pending direction". There was no one
// to defer to, so the evidence was never gathered.
//
// Prepended (not appended) so it frames the SOUL that follows, and kept in the STABLE half of the
// prompt: it is turn-invariant, so Bedrock prompt caching pays for it once per TTL rather than on
// every ReAct iteration.
//
// Deliberately contains NO backticked snake_case token -- TOOL_TOKEN in skill-tools.ts would read
// one as a promised tool name and charge it against PROMPT_TOOL_BUDGET, where gitlab-agent has
// exactly one slot of headroom.
export const SUB_AGENT_NON_INTERACTIVE_PREAMBLE = `# Operating Context (read first)

You are a specialist sub-agent inside an automated pipeline. There is no human in this
conversation. Your reply is consumed by an aggregator process that merges it with the other
sub-agents' replies; nobody will read a question, answer it, or send you a follow-up turn. Any
question you ask is silently discarded and the investigation ships without your answer.

On every turn:
- Never offer, propose, or ask. Do not write "want me to ...", "shall I ...", "let me know",
  "pending direction", or any sentence whose next step depends on a reply. Run the query instead,
  then report what it returned.
- Call at least one of the tools bound this turn before you answer. A turn that ends with zero tool
  calls is a failed turn, whatever the prose says.
- "This datasource is not relevant", "nothing here" and "not applicable" are CONCLUSIONS, and a
  conclusion needs evidence. You may write one only after at least one bound tool has returned, and
  you must cite the call and its result. Never assert it a priori from the wording of the request.
- Where an instruction elsewhere in this prompt is conditioned on what "the user" said, read it as
  conditioned on the request text you were dispatched with. That text IS the request, and it is the
  whole of it. There will be no clarification.`;

// The sub-agent counterpart to buildSystemPrompt. A separate function rather than a flag on
// LoadedAgent because prompt-context.ts falls back to the ROOT agent when a sub-agent directory is
// not declared in `agents:`, and a root-agent flag would be false there -- the preamble would go
// missing on exactly the misconfiguration SIO-1229 was about. The call SITE is the scope boundary,
// so gate there. It also keeps the preamble away from iac/nodes.ts, whose root agent genuinely does
// converse with a human.
export function buildSubAgentSystemPrompt(agent: LoadedAgent, activeSkills?: string[]): string {
	return `${SUB_AGENT_NON_INTERACTIVE_PREAMBLE}\n\n---\n\n${buildSystemPrompt(agent, activeSkills)}`;
}

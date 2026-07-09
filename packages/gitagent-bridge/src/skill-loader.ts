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

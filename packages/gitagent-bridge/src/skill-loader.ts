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

export function buildSystemPrompt(agent: LoadedAgent, activeSkills?: string[]): string {
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

	if (agent.knowledge.length > 0) {
		sections.push(buildKnowledgeSection(agent.knowledge));
	}

	return sections.join("\n\n---\n\n");
}

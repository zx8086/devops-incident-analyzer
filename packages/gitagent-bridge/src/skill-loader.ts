// gitagent-bridge/src/skill-loader.ts
import type { KnowledgeEntry } from "./manifest-loader.ts";
import type { LoadedAgent } from "./manifest-loader.ts";

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

export function buildSystemPrompt(agent: LoadedAgent, activeSkills?: string[]): string {
	const sections: string[] = [];

	if (agent.soul) {
		sections.push(agent.soul.trim());
	}

	if (agent.rules) {
		sections.push(agent.rules.trim());
	}

	const skillsToLoad = activeSkills ?? [...agent.skills.keys()];
	for (const skillName of skillsToLoad) {
		const content = agent.skills.get(skillName);
		if (content) {
			const bodyOnly = content.replace(/^---[\s\S]*?---\s*/m, "").trim();
			if (bodyOnly) {
				sections.push(`## Skill: ${skillName}\n\n${bodyOnly}`);
			}
		}
	}

	if (agent.knowledge.length > 0) {
		sections.push(buildKnowledgeSection(agent.knowledge));
	}

	return sections.join("\n\n---\n\n");
}

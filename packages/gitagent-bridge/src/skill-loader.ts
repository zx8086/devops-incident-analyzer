// gitagent-bridge/src/skill-loader.ts
import type { LoadedAgent } from "./manifest-loader.ts";

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

  return sections.join("\n\n---\n\n");
}

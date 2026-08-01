// agent/src/learn/skill-pr.ts
//
// SIO-1346: pure builders for the skill-promotion PR an approved HIL heuristic
// opens (kind:new-skill, the SIO-849 slot). Mirrors draftRunbook's split: files
// and PR text are built here, the GitHub write happens in apply.ts via
// promoteToMemory. No I/O so the agent.yaml staleness property -- the edit must
// apply to the BASE branch's live content, never a local snapshot -- is
// directly unit-testable.

import type { MemoryPrFile } from "@devops-agent/memory-pr";
import type { AnnotationMap } from "@devops-agent/shared";
import { addSkillToManifest } from "../skill-manifest.ts";
import { renderSkillMarkdown } from "../skill-promote.ts";
import { buildPrBody, buildPrTitle } from "../skill-promote-git.ts";

// The HIL learn lane only runs for the orchestrator (LEARNER_AGENT in
// skill-learner.ts), so the target agent is fixed.
export const SKILL_PR_AGENT = "incident-analyzer";
export const AGENT_MANIFEST_PATH = `agents/${SKILL_PR_AGENT}/agent.yaml`;
export const SKILL_DIR = `agents/${SKILL_PR_AGENT}/skills`;

export interface SkillPrInput {
	skillName: string;
	annotations: AnnotationMap;
	body: string;
}

export type SkillPrFilesResult = { ok: true; files: MemoryPrFile[] } | { ok: false; reason: string };

// baseManifestYaml MUST be the agent.yaml content fetched from the base branch
// (fetchBaseFileContent) -- the memory-pr tree write replaces the whole file,
// so building the edit from a stale local checkout would silently drop
// concurrently merged skills: entries.
export function buildSkillPrFiles(baseManifestYaml: string, input: SkillPrInput): SkillPrFilesResult {
	let edit: ReturnType<typeof addSkillToManifest>;
	try {
		edit = addSkillToManifest(baseManifestYaml, input.skillName);
	} catch (error) {
		return { ok: false, reason: `agent.yaml edit failed: ${error instanceof Error ? error.message : String(error)}` };
	}
	if (!edit.changed) {
		// Second dedup layer, independent of skillProposalExists: the manifest already
		// lists the skill (e.g. a sibling PR merged), so there is nothing to activate.
		return { ok: false, reason: `skill "${input.skillName}" already listed in agent.yaml` };
	}
	const markdown = renderSkillMarkdown({ annotations: input.annotations, body: input.body }, { mode: "pr" });
	return {
		ok: true,
		files: [
			{ path: `${SKILL_DIR}/${input.skillName}/SKILL.md`, contents: markdown },
			{ path: AGENT_MANIFEST_PATH, contents: edit.content },
		],
	};
}

export function buildSkillPrTitle(skillName: string): string {
	return buildPrTitle(SKILL_PR_AGENT, skillName);
}

export function buildSkillPrBody(skillName: string, annotations: AnnotationMap): string {
	return buildPrBody({ agent: SKILL_PR_AGENT, skill: skillName, annotations });
}

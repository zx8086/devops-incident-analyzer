// agent/src/skill-manifest.ts
//
// SIO-1345: read/edit helpers for an agent.yaml `skills:` list. The READ uses a real
// YAML parse so both GAP dialects (`- name` and `- id: name`) are recognized; the
// EDIT is line-based (never parse+stringify) so comments and formatting elsewhere in
// the hand-curated manifest survive byte-for-byte.

import { parse } from "yaml";

export interface ManifestEdit {
	content: string;
	changed: boolean;
}

export function manifestHasSkill(yamlText: string, skillName: string): boolean {
	let doc: unknown;
	try {
		doc = parse(yamlText);
	} catch {
		return false;
	}
	if (typeof doc !== "object" || doc === null) return false;
	const skills = (doc as Record<string, unknown>).skills;
	if (!Array.isArray(skills)) return false;
	return skills.some((entry) =>
		typeof entry === "string"
			? entry === skillName
			: typeof entry === "object" && entry !== null && (entry as Record<string, unknown>).id === skillName,
	);
}

// Insert skillName at the end of the `skills:` block, matching the block's existing
// dialect and indentation. Idempotent. Throws when the manifest has no top-level
// `skills:` key -- the caller must not guess where the list belongs.
export function addSkillToManifest(yamlText: string, skillName: string): ManifestEdit {
	if (manifestHasSkill(yamlText, skillName)) return { content: yamlText, changed: false };
	const lines = yamlText.split("\n");
	const headerIdx = lines.findIndex((line) => /^skills:\s*(#.*)?$/.test(line));
	if (headerIdx === -1) {
		throw new Error("agent.yaml has no top-level `skills:` list; add the skill entry by hand");
	}
	let lastEntryIdx = headerIdx;
	let indent = "  ";
	let dialect: "plain" | "id" = "plain";
	for (let i = headerIdx + 1; i < lines.length; i++) {
		const m = lines[i]?.match(/^(\s+)-\s+(.*)$/);
		if (!m) break;
		lastEntryIdx = i;
		indent = m[1] ?? "  ";
		if (/^id:\s/.test(m[2] ?? "")) dialect = "id";
	}
	const entry = dialect === "id" ? `${indent}- id: ${skillName}` : `${indent}- ${skillName}`;
	lines.splice(lastEntryIdx + 1, 0, entry);
	return { content: lines.join("\n"), changed: true };
}

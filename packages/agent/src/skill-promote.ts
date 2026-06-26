// agent/src/skill-promote.ts
//
// SIO-1017: pure core of the skill-promotion scaffolder. Turns a SIO-1015
// kind:skill proposal (a durable agent-memory fact: string annotations + a prose
// body) into a SKILL.md draft whose frontmatter satisfies SIO-1014's
// SkillFrontmatterSchema. PROPOSE-ONLY: this only produces a DRAFT file for human
// review; it never auto-loads the skill (skill-promote-cli.ts owns I/O and never
// touches agent.yaml). No I/O here so the transforms are unit-testable.

import { type SkillFrontmatter, SkillFrontmatterSchema } from "@devops-agent/gitagent-bridge";
import type { AnnotationMap } from "@devops-agent/shared";
import { stringify } from "yaml";

// The three prose sections recovered from a proposal fact body. whenToUse may be
// absent (agent-memory paraphrases on ingest and strips the labels — see
// reference_agent_memory_paraphrases_on_ingest), in which case the whole body
// becomes the procedure and description falls back to the first sentence.
export interface ParsedSkillBody {
	description?: string;
	whenToUse?: string;
	procedure: string;
}

export interface SkillScaffoldInput {
	annotations: AnnotationMap;
	body: string;
}

// Inverse of buildSkillFactText, but LENIENT: the literal markers ("Proposed
// skill:", "When to use:", "Procedure:") only survive when the fact body was NOT
// paraphrased by the agent-memory service. Try them; on a miss, degrade to "the
// whole body is the procedure" rather than failing — the output is a reviewed
// DRAFT, so a coarse split is acceptable and a human fixes it.
export function parseSkillFactBody(body: string): ParsedSkillBody {
	const text = body.trim();
	// "Proposed skill: <name> - <description>": strip up to the " - " separator. Use
	// the FIRST " - " (the name/description divider) — a kebab name like "lag-correlation"
	// has no surrounding spaces so it is not mistaken for the separator.
	const proposedLine = matchLabel(text, "Proposed skill:");
	const description = proposedLine?.replace(/^.*?\s-\s/, "") ?? firstSentence(text);
	const whenToUse = matchLabel(text, "When to use:");
	const procedure = matchLabel(text, "Procedure:") ?? text;
	return {
		...(description ? { description } : {}),
		...(whenToUse ? { whenToUse } : {}),
		procedure,
	};
}

// Pull the text following a "Label:" line up to the next labelled line or end.
function matchLabel(text: string, label: string): string | undefined {
	const idx = text.indexOf(label);
	if (idx === -1) return undefined;
	const after = text.slice(idx + label.length);
	// stop at the next known label so a single-line body splits cleanly
	const next = after.search(/\n(?:Proposed skill:|When to use:|Procedure:)/);
	const slice = next === -1 ? after : after.slice(0, next);
	return slice.trim() || undefined;
}

function firstSentence(text: string): string | undefined {
	const m = text.match(/^.*?[.!?](?=\s|$)/);
	return (m?.[0] ?? text.split("\n")[0])?.trim() || undefined;
}

// Convert the string-valued annotation map into a TYPED SkillFrontmatter and
// validate it against the loader's schema. confidence -> number, counts -> ints,
// blank/absent keys are dropped (not emitted as empty strings). Throws (via
// SkillFrontmatterSchema.parse) when an annotation is malformed (e.g. confidence
// out of [0,1]) so a bad proposal never yields an invalid draft.
export function buildSkillFrontmatter(annotations: AnnotationMap, prose: { description?: string }): SkillFrontmatter {
	const draft: Record<string, unknown> = {};
	const name = annotations.skill_name?.trim();
	if (name) draft.name = name;
	if (prose.description) draft.description = prose.description;
	addString(draft, "task_category", annotations.task_category);
	addString(draft, "learned_from", annotations.learned_from);
	addString(draft, "learned_at", annotations.learned_at);
	addNumber(draft, "confidence", annotations.confidence);
	addNumber(draft, "usage_count", annotations.usage_count);
	addNumber(draft, "success_count", annotations.success_count);
	addNumber(draft, "failure_count", annotations.failure_count);
	return SkillFrontmatterSchema.parse(draft);
}

function addString(target: Record<string, unknown>, key: string, value: string | undefined): void {
	const v = value?.trim();
	if (v) target[key] = v;
}

function addNumber(target: Record<string, unknown>, key: string, value: string | undefined): void {
	if (value === undefined || value.trim() === "") return;
	const n = Number(value);
	// Leave non-numeric values in as-is so SkillFrontmatterSchema rejects them with a
	// clear error rather than silently coercing NaN.
	target[key] = Number.isNaN(n) ? value : n;
}

const DRAFT_BANNER = `# DRAFT — review before use

> This skill was scaffolded from a learned proposal (SIO-1017). Review the
> procedure, edit it for correctness, and remove this banner before relying on it.
> It is NOT loaded until you add it to the agent's \`agent.yaml\` \`skills:\` list.`;

// Render the full SKILL.md text: YAML frontmatter (round-trips through the loader's
// yaml `parse` + SkillFrontmatterSchema) + DRAFT banner + the recovered sections.
export function renderSkillMarkdown(input: SkillScaffoldInput): string {
	const parsed = parseSkillFactBody(input.body);
	const frontmatter = buildSkillFrontmatter(input.annotations, {
		...(parsed.description ? { description: parsed.description } : {}),
	});
	const yaml = stringify(frontmatter).trimEnd();
	const sections = [`---\n${yaml}\n---`, "", DRAFT_BANNER];
	if (parsed.whenToUse) sections.push("", "## When to use", "", parsed.whenToUse);
	sections.push("", "## Procedure", "", parsed.procedure, "");
	return sections.join("\n");
}

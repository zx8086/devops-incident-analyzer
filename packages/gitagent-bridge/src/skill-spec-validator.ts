// gitagent-bridge/src/skill-spec-validator.ts
// SIO-1347: agentskills.io spec-compliance validator for SKILL.md frontmatter.
// The runtime loader (parseSkillFrontmatter) stays deliberately tolerant -- it
// degrades to a minimal record so a malformed skill never breaks agent load.
// This module is the strict counterpart: a build-time conformance gate run by
// skill-spec-compliance.test.ts over the real agents/ and .agents/skills trees,
// and by the learn-lane generator tests (skill-pr.test.ts) so a promoted skill's
// PR cannot ship frontmatter the spec gate would reject.
//
// Spec: https://agentskills.io/specification -- top-level fields are name
// (required), description (required), license, compatibility, metadata,
// allowed-tools. This repo layers documented extension fields on top (see
// SKILL_EXTENSION_FIELDS); anything else fails the unknown-field rule.

import { basename, dirname } from "node:path";
import { parse } from "yaml";

export interface SkillSpecViolation {
	rule:
		| "no-frontmatter"
		| "frontmatter-parse-error"
		| "name-required"
		| "name-format"
		| "name-too-long"
		| "name-mismatch"
		| "description-required"
		| "description-too-long"
		| "unknown-field";
	detail: string;
}

// Lowercase alphanumeric segments joined by single hyphens: structurally forbids
// uppercase, leading/trailing hyphens, and consecutive hyphens (each segment is
// non-empty), matching the spec's name constraints exactly.
const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const MAX_NAME_LENGTH = 64;
const MAX_DESCRIPTION_LENGTH = 1024;

// The six top-level fields the agentskills.io spec defines.
export const SKILL_SPEC_FIELDS: ReadonlySet<string> = new Set([
	"name",
	"description",
	"license",
	"compatibility",
	"metadata",
	"allowed-tools",
]);

// Documented repo extensions (kept top-level per the SIO-1347 minimal-alignment
// decision). inputs/outputs: elastic-iac skill contracts. confidence through
// negative_examples: SIO-1015/1017 skill-learning fields; task_category is
// emitted by the SIO-1346 learn-lane writer (buildSkillFrontmatter in
// packages/agent/src/skill-promote.ts). version/category: .agents/skills
// operator-skill fields. Adding a new extension field requires updating this
// set in the same PR that introduces the first skill using it.
export const SKILL_EXTENSION_FIELDS: ReadonlySet<string> = new Set([
	"inputs",
	"outputs",
	"confidence",
	"task_category",
	"learned_from",
	"learned_at",
	"usage_count",
	"success_count",
	"failure_count",
	"negative_examples",
	"version",
	"category",
]);

// Locate the frontmatter block with the same delimiters parseSkillFrontmatter
// accepts, but report violations instead of degrading.
function extractFrontmatterYaml(content: string): { yaml: string } | { violation: SkillSpecViolation } {
	if (!content.startsWith("---\n") && !content.startsWith("---\r\n")) {
		return {
			violation: { rule: "no-frontmatter", detail: "file must start with a --- frontmatter block (name, description)" },
		};
	}
	const afterOpening = content.indexOf("\n") + 1;
	const closingMatch = content.slice(afterOpening).match(/^---\r?\n?/m);
	if (!closingMatch || closingMatch.index === undefined) {
		return { violation: { rule: "no-frontmatter", detail: "missing closing --- delimiter" } };
	}
	return { yaml: content.slice(afterOpening, afterOpening + closingMatch.index) };
}

// Validate one SKILL.md against the agentskills.io frontmatter contract. Returns
// every violation found (not fail-fast) so a single run surfaces the full list.
export function validateSkillFile(filePath: string, content: string): SkillSpecViolation[] {
	const extracted = extractFrontmatterYaml(content);
	if ("violation" in extracted) return [extracted.violation];

	let parsed: unknown;
	try {
		parsed = parse(extracted.yaml) ?? {};
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return [{ rule: "frontmatter-parse-error", detail: message }];
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		return [{ rule: "frontmatter-parse-error", detail: "frontmatter must be a YAML mapping" }];
	}
	const frontmatter = parsed as Record<string, unknown>;
	const violations: SkillSpecViolation[] = [];

	const name = frontmatter.name;
	if (typeof name !== "string" || name.length === 0) {
		violations.push({ rule: "name-required", detail: "name is required and must be a non-empty string" });
	} else {
		if (!NAME_RE.test(name)) {
			violations.push({
				rule: "name-format",
				detail: `name "${name}" must be lowercase alphanumeric segments joined by single hyphens`,
			});
		}
		if (name.length > MAX_NAME_LENGTH) {
			violations.push({ rule: "name-too-long", detail: `name is ${name.length} chars (max ${MAX_NAME_LENGTH})` });
		}
		const dir = basename(dirname(filePath));
		if (name !== dir) {
			violations.push({ rule: "name-mismatch", detail: `name "${name}" must equal parent directory "${dir}"` });
		}
	}

	const description = frontmatter.description;
	if (typeof description !== "string" || description.trim().length === 0) {
		violations.push({
			rule: "description-required",
			detail: "description is required and must be a non-empty string",
		});
	} else if (description.length > MAX_DESCRIPTION_LENGTH) {
		violations.push({
			rule: "description-too-long",
			detail: `description is ${description.length} chars (max ${MAX_DESCRIPTION_LENGTH})`,
		});
	}

	for (const key of Object.keys(frontmatter)) {
		if (!SKILL_SPEC_FIELDS.has(key) && !SKILL_EXTENSION_FIELDS.has(key)) {
			violations.push({
				rule: "unknown-field",
				detail: `unknown top-level field "${key}" (not an agentskills.io spec field or a documented repo extension)`,
			});
		}
	}

	return violations;
}

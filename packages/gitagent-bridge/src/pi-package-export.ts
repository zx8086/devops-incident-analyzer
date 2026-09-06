// gitagent-bridge/src/pi-package-export.ts
// SIO-1649: render an agent definition into a Pi package (context files plus
// agentskills.io skill folders) for the pi-coms fleet. Allowlist-only: SOUL,
// portable shared context, RULES, DUTIES, the skills catalog, knowledge bodies
// and hand-authored skills. memory/, hooks/, compliance/, workflows/ and learned
// skills are never touched, and any 12-digit account id refuses the export.
// Never calls buildSubAgentSystemPrompt: its non-interactive preamble would
// break a spoke that replies to coms turns.
import { parse, stringify } from "yaml";
import type { LoadedAgent } from "./manifest-loader.ts";
import { buildSkillsCatalog, buildSystemPromptParts } from "./skill-loader.ts";
import { SKILL_SPEC_FIELDS } from "./skill-spec-validator.ts";
import { provenanceHeader } from "./version.ts";

export type ExportedFile = { path: string; content: string };

export type PiPackageExport = {
	name: string;
	version: string;
	files: ExportedFile[];
	skills: string[];
};

export type RenderContextOptions = {
	// The only supported value: Pi discloses skills progressively, so bodies live
	// in skills/<name>/SKILL.md and the context file keeps the catalog only.
	inlineSkills: false;
	header?: string;
};

const SECTION_SEPARATOR = "\n\n---\n\n";
const ACCOUNT_ID_RE = /\b[0-9]{12}\b/;

// Same order as buildSystemPromptParts: SOUL, shared context, RULES, DUTIES,
// skills catalog, then the knowledge tail; the skill bodies are the only
// sections left out. Shared context is the PORTABLE part only.
export function renderContextFile(agent: LoadedAgent, options: RenderContextOptions): string {
	const sections: string[] = [];
	if (agent.soul) sections.push(agent.soul.trim());
	const shared = agent.sharedContextPortable?.trim();
	if (shared) sections.push(`## Shared Context\n\n${shared}`);
	if (agent.rules) sections.push(agent.rules.trim());
	if (agent.duties?.trim()) sections.push(agent.duties.trim());
	const catalog = buildSkillsCatalog(agent);
	if (catalog) sections.push(catalog);
	const body = sections.join(SECTION_SEPARATOR) + buildSystemPromptParts(agent).knowledge;
	return options.header ? `${options.header}\n\n${body}\n` : `${body}\n`;
}

export function assertNoAccountIds(path: string, content: string): void {
	const hit = ACCOUNT_ID_RE.exec(content);
	if (hit) {
		throw new Error(`${path}: contains a 12-digit account id (${hit[0]}); refusing to export`);
	}
}

function splitFrontmatter(skillName: string, raw: string): { frontmatter: Record<string, unknown>; body: string } {
	if (!raw.startsWith("---\n") && !raw.startsWith("---\r\n")) {
		throw new Error(`skill "${skillName}": SKILL.md has no frontmatter block`);
	}
	const afterOpening = raw.indexOf("\n") + 1;
	const closing = raw.slice(afterOpening).match(/^---[ \t]*\r?\n?/m);
	if (!closing || closing.index === undefined) {
		throw new Error(`skill "${skillName}": SKILL.md frontmatter has no closing delimiter`);
	}
	const yamlText = raw.slice(afterOpening, afterOpening + closing.index);
	const parsed: unknown = parse(yamlText) ?? {};
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error(`skill "${skillName}": SKILL.md frontmatter is not a mapping`);
	}
	const body = raw.slice(afterOpening + closing.index + closing[0].length);
	return { frontmatter: parsed as Record<string, unknown>, body };
}

// agentskills.io keeps the six spec fields top-level; every documented repo
// extension moves under `metadata` so Pi and other consumers see a clean spec
// file. Learned skills (learned_from) are never exported.
export function foldSkillFrontmatter(skillName: string, raw: string): string {
	const { frontmatter, body } = splitFrontmatter(skillName, raw);
	if ("learned_from" in frontmatter) {
		throw new Error(`skill "${skillName}": learned skills (learned_from) are never exported`);
	}
	if (typeof frontmatter.description !== "string" || frontmatter.description.trim() === "") {
		throw new Error(`skill "${skillName}": description is required (Pi drops a skill without one)`);
	}
	const spec: Record<string, unknown> = {};
	const extensions: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(frontmatter)) {
		if (SKILL_SPEC_FIELDS.has(key)) spec[key] = value;
		else extensions[key] = value;
	}
	if (typeof spec.name !== "string") spec.name = skillName;
	if (Object.keys(extensions).length > 0) {
		const existing =
			typeof spec.metadata === "object" && spec.metadata !== null ? (spec.metadata as Record<string, unknown>) : {};
		spec.metadata = { ...existing, ...extensions };
	}
	const ordered: Record<string, unknown> = { name: spec.name, description: spec.description };
	for (const [key, value] of Object.entries(spec)) {
		if (key !== "name" && key !== "description") ordered[key] = value;
	}
	// lineWidth 0: never fold a long description across lines; Pi's frontmatter
	// reader must see one `description:` line.
	return `---\n${stringify(ordered, { lineWidth: 0 })}---\n${body}`;
}

function collectSkills(agent: LoadedAgent, into: Map<string, string>): void {
	for (const [name, raw] of agent.skills) if (!into.has(name)) into.set(name, raw);
	for (const [name, raw] of agent.sharedSkills) if (!into.has(name)) into.set(name, raw);
}

export function buildPiPackage(opts: {
	root: LoadedAgent;
	subAgents?: string[];
	name: string;
	version: string;
	sha?: string;
}): PiPackageExport {
	const files: ExportedFile[] = [];
	const header = provenanceHeader(opts.name, opts.version, opts.sha);
	files.push({ path: "AGENTS.md", content: renderContextFile(opts.root, { inlineSkills: false, header }) });

	const skills = new Map<string, string>();
	collectSkills(opts.root, skills);
	const subNames = opts.subAgents ?? [...opts.root.subAgents.keys()];
	for (const subName of subNames) {
		const sub = opts.root.subAgents.get(subName);
		if (!sub) throw new Error(`sub-agent "${subName}" is not declared by ${opts.root.manifest.name}`);
		files.push({
			path: `${subName}/AGENTS.override.md`,
			content: renderContextFile(sub, { inlineSkills: false, header }),
		});
		collectSkills(sub, skills);
	}
	for (const [skillName, raw] of skills) {
		files.push({ path: `skills/${skillName}/SKILL.md`, content: foldSkillFrontmatter(skillName, raw) });
	}

	const manifest = {
		name: opts.name,
		version: opts.version,
		private: true,
		description: opts.root.manifest.description.trim(),
		keywords: ["pi-package"],
		pi: { skills: ["./skills"] },
	};
	files.push({ path: "package.json", content: `${JSON.stringify(manifest, null, "\t")}\n` });

	for (const file of files) assertNoAccountIds(file.path, file.content);
	return { name: opts.name, version: opts.version, files, skills: [...skills.keys()] };
}

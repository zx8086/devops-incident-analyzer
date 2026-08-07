// gitagent-bridge/src/okf-spec-audit.ts
// SIO-1440: tier-1 static consistency checks for the OKF spec (agent.yaml/SOUL/RULES/knowledge).
// These are audit-time gates, deliberately separate from manifest-loader.ts's runtime loader --
// the runtime loader stays tolerant by design (see SIO-1282 comments in manifest-loader.ts), so a
// malformed knowledge file never takes down agent load in production. This module answers a
// different question: "does any file rely on that tolerance right now?" -- which the loader itself
// cannot report, since its tolerant path swallows the error instead of surfacing it.
import type { Dirent } from "node:fs";
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { parseRunbookFrontmatter } from "./manifest-loader.ts";
import type { KnowledgeIndex } from "./types.ts";

export interface FrontmatterDegradation {
	category: string;
	filename: string;
	path: string;
	error: string;
}

// Walks every category directory in knowledge/index.yaml and re-parses each file's
// frontmatter with the same parser manifest-loader.ts uses, reporting every file that
// would hit the tolerant-catch fallback in stripFrontmatter (silently degrading: content
// unstripped, no lifecycle fields) instead of letting it pass unnoticed.
export function findFrontmatterDegradations(agentDir: string, index: KnowledgeIndex): FrontmatterDegradation[] {
	const knowledgeDir = join(agentDir, "knowledge");
	const degradations: FrontmatterDegradation[] = [];

	for (const [category, config] of Object.entries(index.categories)) {
		const categoryDir = join(knowledgeDir, config.path);
		let files: string[];
		try {
			files = readdirSync(categoryDir).filter((f) => f.endsWith(".md") && f !== ".gitkeep");
		} catch {
			continue;
		}

		for (const filename of files) {
			const path = join(categoryDir, filename);
			const rawContent = readFileSync(path, "utf-8").trim();
			if (!rawContent) continue;
			if (!rawContent.startsWith("---\n") && !rawContent.startsWith("---\r\n")) continue;

			try {
				parseRunbookFrontmatter(rawContent);
			} catch (err) {
				degradations.push({
					category,
					filename,
					path,
					error: err instanceof Error ? err.message : String(err),
				});
			}
		}
	}

	return degradations;
}

export interface OrphanedKnowledgeFile {
	path: string;
}

// OKF v0.2 reserves knowledge/index.md as the bundle-root listing file: a self-describing
// manifest that documents the categories below it, explicitly NOT prompt-loaded (see its
// own body). It is the one legitimate file that sits directly under knowledge/ outside any
// declared category, so it is excluded rather than flagged.
const OKF_BUNDLE_ROOT_FILE = "index.md";

// Walks every directory under knowledge/ and flags any .md file whose containing
// directory is not the `path` of a declared category in knowledge/index.yaml. Such a
// file is invisible to the loader entirely (loadKnowledge only reads declared category
// directories), so it can never reach a prompt, never be selected by the SIO-640
// runbook selector, and never surface to a reader browsing index.yaml -- dead weight
// an author may believe is live.
export function findOrphanedKnowledgeFiles(agentDir: string, index: KnowledgeIndex): OrphanedKnowledgeFile[] {
	const knowledgeDir = join(agentDir, "knowledge");
	// join() normalizes internal separators but preserves a trailing separator from
	// config.path (e.g. "general/runbooks/" or, on Windows, "general\\runbooks\\"), while the
	// walk below produces dirs with no trailing separator -- strip either kind so both sides
	// compare equal (CodeRabbit, PR #632: /\/$/ alone missed the Windows backslash case).
	const declaredDirs = new Set(
		Object.values(index.categories).map((c) => join(knowledgeDir, c.path).replace(/[\\/]$/, "")),
	);

	const orphans: OrphanedKnowledgeFile[] = [];
	const walk = (dir: string) => {
		let entries: string[];
		try {
			entries = readdirSync(dir);
		} catch {
			return;
		}
		for (const entry of entries) {
			const full = join(dir, entry);
			// CodeRabbit (PR #632): statSync() follows directory symlinks, so a self-referential
			// link under knowledge/ threw ELOOP and crashed the whole audit uncaught. lstatSync()
			// identifies the link itself rather than following it, so the walk treats a symlink
			// as a leaf (never recurses into or through it) instead of looping or escaping the
			// intended knowledge/ tree.
			if (lstatSync(full).isDirectory()) {
				walk(full);
			} else if (
				entry.endsWith(".md") &&
				entry !== ".gitkeep" &&
				!(dir === knowledgeDir && entry === OKF_BUNDLE_ROOT_FILE) &&
				!declaredDirs.has(dir)
			) {
				orphans.push({ path: relative(agentDir, full) });
			}
		}
	};
	walk(knowledgeDir);

	return orphans;
}

export interface SkillDeclarationDrift {
	kind: "undeclared_skill_dir" | "missing_skill_file";
	name: string;
	path: string;
}

// SIO-1444: local skills are a manifest ALLOWLIST, not a directory scan -- manifest-loader.ts
// iterates `manifest.skills` and existsSync-checks each, so a skills/<name>/ directory that is
// not declared in agent.yaml never loads (the SIO-1281 failure mode: 16 elastic-iac skill
// directories silently dropped ~1,300 lines), and a declared name with no SKILL.md silently
// loads as nothing. index.test.ts pins this for the ROOT incident-analyzer and elastic-iac
// agents only; this function is the per-agent-dir form the spec-audit CLI runs across the root
// AND every declared sub-agent (capella/elastic/gitlab ship sub-agent skills today).
//
// `declaredSkills` is the LOADED manifest's list (manifest.skills ?? []): both agent.yaml
// dialects (plain strings, GAP `- id:` objects) normalize to string[] through toIdList in
// AgentManifestSchema, so callers pass the parsed manifest rather than re-parsing YAML here.
//
// An undeclared directory WITHOUT a SKILL.md is deliberately not flagged (same rule as the
// SIO-1281 test): it is unloadable under any declaration, so nothing live is being lost.
export function findSkillDeclarationDrift(agentDir: string, declaredSkills: string[]): SkillDeclarationDrift[] {
	const skillsDir = join(agentDir, "skills");
	const declared = new Set(declaredSkills);
	const drifts: SkillDeclarationDrift[] = [];

	let entries: Dirent[];
	try {
		entries = readdirSync(skillsDir, { withFileTypes: true });
	} catch {
		entries = [];
	}
	for (const entry of entries) {
		// Dirent.isDirectory() is false for symlinks, so a link is treated as a leaf --
		// same no-follow rule the ELOOP fix above applies to the knowledge walk.
		if (!entry.isDirectory()) continue;
		if (declared.has(entry.name)) continue;
		if (!existsSync(join(skillsDir, entry.name, "SKILL.md"))) continue;
		drifts.push({
			kind: "undeclared_skill_dir",
			name: entry.name,
			path: relative(agentDir, join(skillsDir, entry.name)),
		});
	}

	for (const name of declaredSkills) {
		if (!existsSync(join(skillsDir, name, "SKILL.md"))) {
			drifts.push({
				kind: "missing_skill_file",
				name,
				path: relative(agentDir, join(skillsDir, name, "SKILL.md")),
			});
		}
	}

	return drifts;
}

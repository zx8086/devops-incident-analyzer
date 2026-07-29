// gitagent-bridge/src/manifest-loader.ts
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { parse } from "yaml";
import { type HooksConfig, loadHooks } from "./hooks.ts";
import { type LoadedMemory, loadMemoryLayout } from "./memory.ts";
import { mergeShared } from "./shared-merge.ts";
import {
	type AgentManifest,
	AgentManifestSchema,
	KnowledgeIndexSchema,
	type KnowledgeSelectionConfig,
	RunbookFrontmatterSchema,
	type RunbookSelectionConfig,
	type RunbookTriggers,
	type SkillFrontmatter,
	SkillFrontmatterSchema,
	type ToolDefinition,
	ToolDefinitionSchema,
} from "./types.ts";
import { loadWorkflows, type WorkflowDef } from "./workflow.ts";

export interface KnowledgeEntry {
	category: string;
	filename: string;
	content: string;
	triggers?: RunbookTriggers;
}

export interface LoadedAgent {
	manifest: AgentManifest;
	soul: string;
	rules: string;
	// GAP dialect: separation-of-duties / role-boundary doc (permitted vs forbidden
	// actions). Empty string when the agent has no DUTIES.md (e.g. incident-analyzer).
	duties: string;
	tools: ToolDefinition[];
	skills: Map<string, string>;
	// SIO-1014: typed SKILL.md frontmatter, keyed by skill name. Total over
	// `skills` (every loaded skill has a record; markdown-only skills get a
	// minimal { name } synthesized). Drives the prompt's Skills catalog.
	skillMeta: Map<string, SkillFrontmatter>;
	subAgents: Map<string, LoadedAgent>;
	knowledge: KnowledgeEntry[];
	// SIO-640: Optional runbook selection config from knowledge/index.yaml.
	// Presence of this field gates whether the runbook selector node is wired
	// into the graph.
	runbookSelection?: RunbookSelectionConfig;
	// SIO-1285: optional per-intent knowledge category selection from
	// knowledge/index.yaml. Presence gates whether the IaC knowledge selector node
	// is edged into buildIacGraph.
	knowledgeSelection?: KnowledgeSelectionConfig;
	// SIO-843: gitagent dynamic-pattern asset trees. hooks/memory/workflows are
	// root-only (sub-agents leave them undefined/empty). sharedSkills/sharedContext
	// are merged from agents/shared for every agent (local overrides shared).
	hooks?: HooksConfig;
	memory?: LoadedMemory;
	workflows: Map<string, WorkflowDef>;
	sharedSkills: Map<string, string>;
	// SIO-1014: typed frontmatter for shared skills (same contract as skillMeta).
	sharedSkillMeta: Map<string, SkillFrontmatter>;
	sharedContext?: string;
}

// SIO-843: Internal recursion options. Lifecycle asset trees (hooks/memory/
// workflows) load only for the root agent; the shared root is resolved once at
// the top-level call (agents/shared) and threaded down so nested sub-agents
// merge against the same monorepo-shared directory, not a per-agent sibling.
interface LoadAgentOptions {
	root: boolean;
	sharedRoot: string;
}

export function loadAgent(agentDir: string, options?: LoadAgentOptions): LoadedAgent {
	const root = options?.root ?? true;
	const sharedRoot = options?.sharedRoot ?? resolve(agentDir, "..", "shared");

	const yamlContent = readFileSync(join(agentDir, "agent.yaml"), "utf-8");
	const rawManifest = parse(yamlContent);
	const manifest = AgentManifestSchema.parse(rawManifest);

	const soul = loadOptionalFile(join(agentDir, "SOUL.md"));
	const rules = loadOptionalFile(join(agentDir, "RULES.md"));
	const duties = loadOptionalFile(join(agentDir, "DUTIES.md"));

	const tools: ToolDefinition[] = [];
	const toolsDir = join(agentDir, "tools");
	if (isDirectory(toolsDir)) {
		const yamlFiles = readdirSync(toolsDir).filter((f) => f.endsWith(".yaml"));
		for (const file of yamlFiles) {
			const toolYaml = parse(readFileSync(join(toolsDir, file), "utf-8"));
			tools.push(ToolDefinitionSchema.parse(toolYaml));
		}
	}

	const skills = new Map<string, string>();
	const skillMeta = new Map<string, SkillFrontmatter>();
	const skillsDir = join(agentDir, "skills");
	if (isDirectory(skillsDir)) {
		for (const skillName of manifest.skills ?? []) {
			const skillPath = join(skillsDir, skillName, "SKILL.md");
			if (existsSync(skillPath)) {
				const content = readFileSync(skillPath, "utf-8");
				skills.set(skillName, content);
				skillMeta.set(skillName, parseSkillFrontmatter(skillName, content));
			}
		}
	}

	const subAgents = new Map<string, LoadedAgent>();
	const agentsDir = join(agentDir, "agents");
	if (isDirectory(agentsDir) && manifest.agents) {
		for (const subAgentName of Object.keys(manifest.agents)) {
			const subAgentDir = join(agentsDir, subAgentName);
			if (existsSync(join(subAgentDir, "agent.yaml"))) {
				subAgents.set(subAgentName, loadAgent(subAgentDir, { root: false, sharedRoot }));
			}
		}
	}

	const { entries: knowledge, runbookSelection, knowledgeSelection } = loadKnowledge(agentDir, manifest.knowledge);

	// SIO-843: lifecycle asset trees are root-only.
	const hooks = root ? loadHooks(agentDir) : undefined;
	const memory = root ? loadMemoryLayout(agentDir) : undefined;
	const workflows = root ? loadWorkflows(agentDir) : new Map<string, WorkflowDef>();

	const base: LoadedAgent = {
		manifest,
		soul,
		rules,
		duties,
		tools,
		skills,
		skillMeta,
		subAgents,
		knowledge,
		runbookSelection,
		knowledgeSelection,
		hooks,
		memory,
		workflows,
		sharedSkills: new Map(),
		sharedSkillMeta: new Map(),
	};

	// SIO-843 / EPIC 5: merge shared skills + context for every agent. Shared
	// tools are appended (local override by name); shared skills fill gaps only.
	const merged = mergeShared(sharedRoot, base);
	return {
		...base,
		tools: merged.tools,
		sharedSkills: merged.sharedSkills,
		sharedSkillMeta: merged.sharedSkillMeta,
		sharedContext: merged.sharedContext,
	};
}

function loadKnowledge(
	agentDir: string,
	manifestKnowledge?: string[],
): {
	entries: KnowledgeEntry[];
	runbookSelection?: RunbookSelectionConfig;
	knowledgeSelection?: KnowledgeSelectionConfig;
} {
	const knowledgeDir = join(agentDir, "knowledge");
	const indexPath = join(knowledgeDir, "index.yaml");

	// GAP dialect: no knowledge/index.yaml, but the manifest enumerates knowledge
	// paths (files + directories). Auto-discover them so the GAP knowledge base loads.
	if (!existsSync(indexPath)) {
		if (manifestKnowledge && manifestKnowledge.length > 0) {
			return { entries: loadKnowledgeFromManifest(agentDir, manifestKnowledge) };
		}
		return { entries: [] };
	}

	const indexYaml = parse(readFileSync(indexPath, "utf-8"));
	const index = KnowledgeIndexSchema.safeParse(indexYaml);
	if (!index.success) return { entries: [] };

	const entries: KnowledgeEntry[] = [];
	for (const [category, config] of Object.entries(index.data.categories)) {
		const categoryDir = join(knowledgeDir, config.path);
		if (!isDirectory(categoryDir)) continue;

		const files = readdirSync(categoryDir).filter((f) => f.endsWith(".md") && f !== ".gitkeep");
		for (const file of files) {
			const rawContent = readFileSync(join(categoryDir, file), "utf-8").trim();
			if (!rawContent) continue;

			// SIO-1282: EVERY category gets frontmatter stripped, not just runbooks. OKF v0.2
			// requires frontmatter on every non-reserved .md, and an unstripped block reaches
			// the prompt as literal YAML prose (~5 KB across elastic-iac's 35 non-runbook
			// files). `triggers` remains meaningful only for runbooks -- other categories
			// simply lose the block from their body.
			//
			// The runbooks THROW is deliberately preserved and NOT extended: a malformed
			// runbook is an authoring error in the SIO-640 selection contract and must fail
			// loudly. Other categories degrade instead -- a bad block there costs prompt
			// noise, not selection correctness, and killing agent load over a playbook typo
			// would be a worse failure than the one it prevents.
			if (category === "runbooks") {
				try {
					const { triggers, body } = parseRunbookFrontmatter(rawContent);
					entries.push({
						category,
						filename: file,
						content: body,
						triggers,
					});
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					throw new Error(`Failed to parse runbook frontmatter in ${join(categoryDir, file)}: ${message}`);
				}
			} else {
				entries.push({ category, filename: file, content: stripFrontmatter(rawContent, join(categoryDir, file)) });
			}
		}
	}

	// SIO-640: validate runbook_selection filenames exist on disk
	if (index.data.runbook_selection) {
		const runbooksCategory = index.data.categories.runbooks;
		if (!runbooksCategory) {
			throw new Error(
				"knowledge/index.yaml: runbook_selection is present but categories.runbooks is not defined. " +
					"runbook_selection requires a runbooks category.",
			);
		}
		const runbooksDir = join(knowledgeDir, runbooksCategory.path);
		const existingFiles = isDirectory(runbooksDir)
			? new Set(readdirSync(runbooksDir).filter((f) => f.endsWith(".md")))
			: new Set<string>();

		const { fallback_by_severity } = index.data.runbook_selection;
		for (const [severity, filenames] of Object.entries(fallback_by_severity)) {
			for (const filename of filenames) {
				if (!existingFiles.has(filename)) {
					throw new Error(
						`knowledge/index.yaml: runbook_selection.fallback_by_severity.${severity} references ` +
							`"${filename}" but no such file exists under ${runbooksCategory.path}`,
					);
				}
			}
		}
	}

	// SIO-1285: validate knowledge_selection references real categories. Without this a
	// typo'd name degrades to "that category silently vanishes from the prompt" -- the
	// under-selection failure mode, and invisible, because a missing category directory
	// is already skipped with a bare `continue` above. Fail loudly at load instead.
	if (index.data.knowledge_selection) {
		const known = new Set(Object.keys(index.data.categories));
		const { by_intent, floor } = index.data.knowledge_selection;
		for (const [intent, categories] of Object.entries(by_intent)) {
			for (const category of categories) {
				if (!known.has(category)) {
					throw new Error(
						`knowledge/index.yaml: knowledge_selection.by_intent.${intent} references ` +
							`"${category}" but no such category is defined under categories:`,
					);
				}
			}
		}
		for (const category of floor) {
			if (!known.has(category)) {
				throw new Error(
					`knowledge/index.yaml: knowledge_selection.floor references "${category}" ` +
						"but no such category is defined under categories:",
				);
			}
		}
	}

	return {
		entries,
		runbookSelection: index.data.runbook_selection,
		knowledgeSelection: index.data.knowledge_selection,
	};
}

// GAP auto-discovery: resolve each manifest `knowledge:` entry. A directory entry
// (e.g. "knowledge/runbooks/") loads every *.md inside it under a category named
// after the directory; a file entry loads under its parent directory's name.
function loadKnowledgeFromManifest(agentDir: string, paths: string[]): KnowledgeEntry[] {
	const entries: KnowledgeEntry[] = [];
	for (const rel of paths) {
		const clean = rel.replace(/\/+$/, "");
		const abs = join(agentDir, clean);
		if (!existsSync(abs)) continue;

		if (isDirectory(abs)) {
			const category = basename(clean);
			for (const file of readdirSync(abs).filter((f) => f.endsWith(".md") && f !== ".gitkeep")) {
				const content = readFileSync(join(abs, file), "utf-8").trim();
				if (content) entries.push(makeKnowledgeEntry(category, file, content));
			}
		} else {
			const category = basename(dirname(clean)) || "knowledge";
			const content = readFileSync(abs, "utf-8").trim();
			if (content) entries.push(makeKnowledgeEntry(category, basename(clean), content));
		}
	}
	return entries;
}

// Runbook frontmatter is parsed when present but tolerated when absent/malformed
// in GAP mode (the portable runbooks are write-ups, not always trigger-tagged).
function makeKnowledgeEntry(category: string, filename: string, content: string): KnowledgeEntry {
	if (category === "runbooks") {
		try {
			const { triggers, body } = parseRunbookFrontmatter(content);
			return { category, filename, content: body, triggers };
		} catch {
			return { category, filename, content };
		}
	}
	// SIO-1282: strip frontmatter for every other category too, so an OKF block never
	// reaches the prompt as literal YAML. Tolerant by design -- see stripFrontmatter.
	return { category, filename, content: stripFrontmatter(content, filename) };
}

// SIO-1282: remove a leading YAML frontmatter block from non-runbook knowledge, so OKF
// metadata does not surface in the prompt as prose. Deliberately TOLERANT, unlike the
// runbook path: these categories carry no selection contract, so a malformed block costs
// prompt noise rather than selection correctness, and throwing would take down agent load
// over a playbook typo. On any parse failure the original content is returned unchanged
// (the block stays visible, which is the pre-SIO-1282 behaviour) and a warning names the
// file so the authoring error is still discoverable.
function stripFrontmatter(content: string, filePath: string): string {
	if (!content.startsWith("---\n") && !content.startsWith("---\r\n")) return content;
	try {
		const { body } = parseRunbookFrontmatter(content);
		return body;
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		console.warn(`knowledge frontmatter (${filePath}): ${message}; leaving content unstripped`);
		return content;
	}
}

// Detects, parses, validates, and strips YAML frontmatter from a runbook file's
// content. Returns { triggers: undefined, body } when no frontmatter is present;
// otherwise returns { triggers, body } with the stripped body. Throws on missing
// closing delimiter, malformed YAML, or Zod validation failures (including empty
// frontmatter blocks, which parse to undefined and are rejected by the schema).
export function parseRunbookFrontmatter(content: string): {
	triggers?: RunbookTriggers;
	body: string;
} {
	if (!content.startsWith("---\n") && !content.startsWith("---\r\n")) {
		return { triggers: undefined, body: content };
	}

	const afterOpening = content.indexOf("\n") + 1;
	// SIO-1282: the delimiter must be a WHOLE line. The previous /^---\r?\n?/m matched the
	// `---` prefix of any line starting with three dashes, so `---not-a-delimiter` was taken
	// as the close: the frontmatter ended early and the body silently lost its leading
	// dashes. Pre-existing, but 3a widens the exposure from 16 runbooks to all 53 knowledge
	// files, so it is fixed here rather than left to a follow-up.
	const closingMatch = content.slice(afterOpening).match(/^---[ \t]*\r?$/m);
	if (!closingMatch || closingMatch.index === undefined) {
		throw new Error("Runbook frontmatter: missing closing --- delimiter");
	}

	const frontmatterYaml = content.slice(afterOpening, afterOpening + closingMatch.index);
	// The `$` anchor stops before the line terminator, so step past it explicitly.
	const afterDelimiter = afterOpening + closingMatch.index + closingMatch[0].length;
	const bodyStart = content.startsWith("\r\n", afterDelimiter)
		? afterDelimiter + 2
		: content.startsWith("\n", afterDelimiter)
			? afterDelimiter + 1
			: afterDelimiter;
	const body = content.slice(bodyStart);

	const parsed = parse(frontmatterYaml);
	const validated = RunbookFrontmatterSchema.parse(parsed);

	return { triggers: validated.triggers, body };
}

// SIO-1014: parse a SKILL.md frontmatter block into typed metadata. Unlike
// parseRunbookFrontmatter (which throws on malformed input), skill loading is
// tolerant: most skills are markdown-only with no frontmatter, so absence and
// malformation both fall back to a minimal { name } record. The record is always
// total over the skill set so the prompt catalog can iterate without guards.
export function parseSkillFrontmatter(skillName: string, content: string): SkillFrontmatter {
	const minimal: SkillFrontmatter = { name: skillName };

	if (!content.startsWith("---\n") && !content.startsWith("---\r\n")) {
		return minimal;
	}

	const afterOpening = content.indexOf("\n") + 1;
	const closingMatch = content.slice(afterOpening).match(/^---\r?\n?/m);
	if (!closingMatch || closingMatch.index === undefined) {
		// gitagent-bridge is intentionally dependency-light (no observability dep);
		// console.warn matches the lib-free posture and is allowed by biome here.
		console.warn(`skill frontmatter (${skillName}): missing closing --- delimiter; using minimal record`);
		return minimal;
	}

	const frontmatterYaml = content.slice(afterOpening, afterOpening + closingMatch.index);
	try {
		const parsed = SkillFrontmatterSchema.parse(parse(frontmatterYaml) ?? {});
		// Fall back to the skill directory name when the author omitted `name`.
		return { ...parsed, name: parsed.name ?? skillName };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		console.warn(`skill frontmatter (${skillName}): parse failed (${message}); using minimal record`);
		return minimal;
	}
}

function loadOptionalFile(path: string): string {
	if (!existsSync(path)) return "";
	return readFileSync(path, "utf-8");
}

function isDirectory(path: string): boolean {
	if (!existsSync(path)) return false;
	return statSync(path).isDirectory();
}

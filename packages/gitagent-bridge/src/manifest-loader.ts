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
	RunbookFrontmatterSchema,
	type RunbookSelectionConfig,
	type RunbookTriggers,
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
	subAgents: Map<string, LoadedAgent>;
	knowledge: KnowledgeEntry[];
	// SIO-640: Optional runbook selection config from knowledge/index.yaml.
	// Presence of this field gates whether the runbook selector node is wired
	// into the graph.
	runbookSelection?: RunbookSelectionConfig;
	// SIO-843: gitagent dynamic-pattern asset trees. hooks/memory/workflows are
	// root-only (sub-agents leave them undefined/empty). sharedSkills/sharedContext
	// are merged from agents/shared for every agent (local overrides shared).
	hooks?: HooksConfig;
	memory?: LoadedMemory;
	workflows: Map<string, WorkflowDef>;
	sharedSkills: Map<string, string>;
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
	const skillsDir = join(agentDir, "skills");
	if (isDirectory(skillsDir)) {
		for (const skillName of manifest.skills ?? []) {
			const skillPath = join(skillsDir, skillName, "SKILL.md");
			if (existsSync(skillPath)) {
				skills.set(skillName, readFileSync(skillPath, "utf-8"));
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

	const { entries: knowledge, runbookSelection } = loadKnowledge(agentDir, manifest.knowledge);

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
		subAgents,
		knowledge,
		runbookSelection,
		hooks,
		memory,
		workflows,
		sharedSkills: new Map(),
	};

	// SIO-843 / EPIC 5: merge shared skills + context for every agent. Shared
	// tools are appended (local override by name); shared skills fill gaps only.
	const merged = mergeShared(sharedRoot, base);
	return {
		...base,
		tools: merged.tools,
		sharedSkills: merged.sharedSkills,
		sharedContext: merged.sharedContext,
	};
}

function loadKnowledge(
	agentDir: string,
	manifestKnowledge?: string[],
): {
	entries: KnowledgeEntry[];
	runbookSelection?: RunbookSelectionConfig;
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

			// Only runbooks get frontmatter parsed. Other categories (systems-map,
			// slo-policies) pass through verbatim.
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
				entries.push({ category, filename: file, content: rawContent });
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

	return { entries, runbookSelection: index.data.runbook_selection };
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
	return { category, filename, content };
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
	const closingMatch = content.slice(afterOpening).match(/^---\r?\n?/m);
	if (!closingMatch || closingMatch.index === undefined) {
		throw new Error("Runbook frontmatter: missing closing --- delimiter");
	}

	const frontmatterYaml = content.slice(afterOpening, afterOpening + closingMatch.index);
	const bodyStart = afterOpening + closingMatch.index + closingMatch[0].length;
	const body = content.slice(bodyStart);

	const parsed = parse(frontmatterYaml);
	const validated = RunbookFrontmatterSchema.parse(parsed);

	return { triggers: validated.triggers, body };
}

function loadOptionalFile(path: string): string {
	if (!existsSync(path)) return "";
	return readFileSync(path, "utf-8");
}

function isDirectory(path: string): boolean {
	if (!existsSync(path)) return false;
	return statSync(path).isDirectory();
}

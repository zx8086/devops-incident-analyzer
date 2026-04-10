// gitagent-bridge/src/manifest-loader.ts
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
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

export interface KnowledgeEntry {
	category: string;
	filename: string;
	content: string;
}

export interface LoadedAgent {
	manifest: AgentManifest;
	soul: string;
	rules: string;
	tools: ToolDefinition[];
	skills: Map<string, string>;
	subAgents: Map<string, LoadedAgent>;
	knowledge: KnowledgeEntry[];
	// SIO-640: Optional runbook selection config from knowledge/index.yaml.
	// Presence of this field gates whether the runbook selector node is wired
	// into the graph.
	runbookSelection?: RunbookSelectionConfig;
}

export function loadAgent(agentDir: string): LoadedAgent {
	const yamlContent = readFileSync(join(agentDir, "agent.yaml"), "utf-8");
	const rawManifest = parse(yamlContent);
	const manifest = AgentManifestSchema.parse(rawManifest);

	const soul = loadOptionalFile(join(agentDir, "SOUL.md"));
	const rules = loadOptionalFile(join(agentDir, "RULES.md"));

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
				subAgents.set(subAgentName, loadAgent(subAgentDir));
			}
		}
	}

	const { entries: knowledge, runbookSelection } = loadKnowledge(agentDir);
	return { manifest, soul, rules, tools, skills, subAgents, knowledge, runbookSelection };
}

function loadKnowledge(agentDir: string): {
	entries: KnowledgeEntry[];
	runbookSelection?: RunbookSelectionConfig;
} {
	const knowledgeDir = join(agentDir, "knowledge");
	const indexPath = join(knowledgeDir, "index.yaml");

	if (!existsSync(indexPath)) return { entries: [] };

	const indexYaml = parse(readFileSync(indexPath, "utf-8"));
	const index = KnowledgeIndexSchema.safeParse(indexYaml);
	if (!index.success) return { entries: [] };

	const entries: KnowledgeEntry[] = [];
	for (const [category, config] of Object.entries(index.data.categories)) {
		const categoryDir = join(knowledgeDir, config.path);
		if (!isDirectory(categoryDir)) continue;

		const files = readdirSync(categoryDir).filter((f) => f.endsWith(".md") && f !== ".gitkeep");
		for (const file of files) {
			const content = readFileSync(join(categoryDir, file), "utf-8").trim();
			if (content) {
				entries.push({ category, filename: file, content });
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

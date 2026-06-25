// gitagent-bridge/src/shared-merge.ts
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { type LoadedAgent, parseSkillFrontmatter } from "./manifest-loader.ts";
import { type SkillFrontmatter, type ToolDefinition, ToolDefinitionSchema } from "./types.ts";

// Shared Context & Skills via Monorepo (EPIC 5). Anything at agents/shared/ is
// merged into every LoadedAgent. Precedence: local always wins; shared fills
// gaps. This is the gitagent "root is shared, leaf overrides" contract.

function isDirectory(path: string): boolean {
	if (!existsSync(path)) return false;
	return statSync(path).isDirectory();
}

// Discovers every <sharedSkillsDir>/<name>/SKILL.md. Unlike local skills (gated
// by manifest.skills), shared skills are discovered by presence on disk. SIO-1014:
// also parses each skill's frontmatter into a parallel meta map.
function discoverSharedSkills(sharedSkillsDir: string): {
	skills: Map<string, string>;
	meta: Map<string, SkillFrontmatter>;
} {
	const skills = new Map<string, string>();
	const meta = new Map<string, SkillFrontmatter>();
	if (!isDirectory(sharedSkillsDir)) return { skills, meta };
	for (const name of readdirSync(sharedSkillsDir)) {
		const skillPath = join(sharedSkillsDir, name, "SKILL.md");
		if (existsSync(skillPath)) {
			const content = readFileSync(skillPath, "utf-8");
			skills.set(name, content);
			meta.set(name, parseSkillFrontmatter(name, content));
		}
	}
	return { skills, meta };
}

function loadSharedTools(sharedToolsDir: string): ToolDefinition[] {
	const tools: ToolDefinition[] = [];
	if (!isDirectory(sharedToolsDir)) return tools;
	for (const file of readdirSync(sharedToolsDir).filter((f) => f.endsWith(".yaml"))) {
		tools.push(ToolDefinitionSchema.parse(parse(readFileSync(join(sharedToolsDir, file), "utf-8"))));
	}
	return tools;
}

export interface SharedMergeResult {
	sharedSkills: Map<string, string>;
	// SIO-1014: typed frontmatter for the (post-shadow) shared skills.
	sharedSkillMeta: Map<string, SkillFrontmatter>;
	sharedContext?: string;
	// agent.tools with shared tools appended (local override by name).
	tools: ToolDefinition[];
	// Shared skill names shadowed by a local skill of the same name; surfaced
	// for logging by the caller so a silently-ignored shared update is visible.
	shadowedSkills: string[];
}

export function mergeShared(sharedRoot: string, agent: LoadedAgent): SharedMergeResult {
	const discovered = discoverSharedSkills(join(sharedRoot, "skills"));
	const sharedSkills = new Map<string, string>();
	const sharedSkillMeta = new Map<string, SkillFrontmatter>();
	const shadowedSkills: string[] = [];
	for (const [name, body] of discovered.skills) {
		if (agent.skills.has(name)) {
			shadowedSkills.push(name);
			continue;
		}
		sharedSkills.set(name, body);
		// Drop shadowed meta exactly like the bodies: only meta for skills that
		// survive the shadow check rides along.
		const meta = discovered.meta.get(name);
		if (meta) sharedSkillMeta.set(name, meta);
	}

	const localToolNames = new Set(agent.tools.map((t) => t.name));
	const tools = [...agent.tools];
	for (const tool of loadSharedTools(join(sharedRoot, "tools"))) {
		if (!localToolNames.has(tool.name)) tools.push(tool);
	}

	const contextPath = join(sharedRoot, "context.md");
	const sharedContext = existsSync(contextPath) ? readFileSync(contextPath, "utf-8") : undefined;

	return { sharedSkills, sharedSkillMeta, sharedContext, tools, shadowedSkills };
}

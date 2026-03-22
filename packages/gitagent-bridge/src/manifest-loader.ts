// gitagent-bridge/src/manifest-loader.ts
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { type AgentManifest, AgentManifestSchema, type ToolDefinition, ToolDefinitionSchema } from "./types.ts";

export interface LoadedAgent {
	manifest: AgentManifest;
	soul: string;
	rules: string;
	tools: ToolDefinition[];
	skills: Map<string, string>;
	subAgents: Map<string, LoadedAgent>;
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

	return { manifest, soul, rules, tools, skills, subAgents };
}

function loadOptionalFile(path: string): string {
	if (!existsSync(path)) return "";
	return readFileSync(path, "utf-8");
}

function isDirectory(path: string): boolean {
	if (!existsSync(path)) return false;
	return statSync(path).isDirectory();
}

// gitagent-bridge/src/tool-prompt.ts
import type { LoadedAgent } from "./manifest-loader.ts";
import type { ToolDefinition } from "./types.ts";

export interface ToolPromptContext {
	datasources?: string[];
	complianceTier?: string;
	activeSkills?: string[];
	agentRole?: string;
	customVariables?: Record<string, string>;
}

export function buildToolPrompt(toolDef: ToolDefinition, context: ToolPromptContext = {}): string {
	const template = toolDef.prompt_template;
	if (!template) return toolDef.description;

	let resolved = template;

	if (context.datasources?.length) {
		const datasourcesList = context.datasources.join(", ");
		resolved = resolved.replace(/\{\{#if datasources\}\}([\s\S]*?)\{\{\/if\}\}/g, (_, inner: string) =>
			inner.replace(/\{\{datasources\}\}/g, datasourcesList),
		);
	} else {
		resolved = resolved.replace(/\{\{#if datasources\}\}[\s\S]*?\{\{\/if\}\}/g, "");
	}

	if (context.complianceTier) {
		const tier = context.complianceTier;
		resolved = resolved.replace(/\{\{#if compliance_tier\}\}([\s\S]*?)\{\{\/if\}\}/g, (_, inner: string) =>
			inner.replace(/\{\{compliance_tier\}\}/g, tier),
		);
	} else {
		resolved = resolved.replace(/\{\{#if compliance_tier\}\}[\s\S]*?\{\{\/if\}\}/g, "");
	}

	if (context.activeSkills?.length) {
		const skillsList = context.activeSkills.join(", ");
		resolved = resolved.replace(/\{\{#if active_skills\}\}([\s\S]*?)\{\{\/if\}\}/g, (_, inner: string) =>
			inner.replace(/\{\{active_skills\}\}/g, skillsList),
		);
	} else {
		resolved = resolved.replace(/\{\{#if active_skills\}\}[\s\S]*?\{\{\/if\}\}/g, "");
	}

	for (const [key, value] of Object.entries(context.customVariables ?? {})) {
		resolved = resolved.replaceAll(`{{${key}}}`, value);
	}

	return resolved
		.replace(/\n{3,}/g, "\n\n")
		.replace(/ {2,}/g, " ")
		.trim();
}

export function buildContextFromAgent(agent: LoadedAgent): ToolPromptContext {
	return {
		datasources: agent.tools.map((t) => t.name),
		complianceTier: agent.manifest.compliance?.risk_tier,
		activeSkills: [...agent.skills.keys()],
		agentRole: agent.manifest.delegation?.mode ?? "auto",
	};
}

export function buildAllToolPrompts(
	agent: LoadedAgent,
	contextOverrides: Partial<ToolPromptContext> = {},
): Map<string, string> {
	const context = { ...buildContextFromAgent(agent), ...contextOverrides };
	const prompts = new Map<string, string>();

	for (const tool of agent.tools) {
		prompts.set(tool.name, buildToolPrompt(tool, context));
	}

	return prompts;
}

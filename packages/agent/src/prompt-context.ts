// agent/src/prompt-context.ts
import {
	buildSystemPrompt,
	type LoadedAgent,
	loadAgent,
	requiresApproval,
	type ToolDefinition,
} from "@devops-agent/gitagent-bridge";
import { getAgentsDir } from "./paths.ts";

let cachedAgent: LoadedAgent | null = null;

export function getAgent(): LoadedAgent {
	if (!cachedAgent) {
		cachedAgent = loadAgent(getAgentsDir());
	}
	return cachedAgent;
}

// SIO-621: Build compliance boundary section listing tools that require human approval.
// This is appended to the orchestrator prompt so the LLM avoids invoking these actions
// without explicit user confirmation.
function buildComplianceBoundary(): string {
	const agent = getAgent();
	const restricted: string[] = [];

	for (const tool of agent.tools) {
		const needsConfirmation =
			tool.annotations?.requires_confirmation === true || requiresApproval(tool.name, agent.manifest.compliance);
		if (needsConfirmation) {
			restricted.push(`- ${tool.name}: ${tool.description.trim()}`);
		}
	}

	if (restricted.length === 0) return "";
	return [
		"\n\n---\n\n## Compliance Boundary",
		"The following actions require explicit human approval before execution.",
		"Do NOT invoke or simulate these actions without user confirmation:\n",
		...restricted,
	].join("\n");
}

export function buildOrchestratorPrompt(): string {
	return buildSystemPrompt(getAgent()) + buildComplianceBoundary();
}

export function buildSubAgentPrompt(agentName: string): string {
	const rootAgent = getAgent();
	const subAgent = rootAgent.subAgents.get(agentName);
	if (!subAgent) return buildSystemPrompt(rootAgent);
	return buildSystemPrompt(subAgent);
}

export function getToolDefinitionForDataSource(dataSourceId: string): ToolDefinition | undefined {
	const agent = getAgent();
	return agent.tools.find((t) => t.tool_mapping?.mcp_server === dataSourceId);
}

// agent/src/prompt-context.ts
import { buildSystemPrompt, type LoadedAgent, loadAgent, type ToolDefinition } from "@devops-agent/gitagent-bridge";
import { getAgentsDir } from "./paths.ts";

let cachedAgent: LoadedAgent | null = null;

export function getAgent(): LoadedAgent {
	if (!cachedAgent) {
		cachedAgent = loadAgent(getAgentsDir());
	}
	return cachedAgent;
}

export function buildOrchestratorPrompt(): string {
	return buildSystemPrompt(getAgent());
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

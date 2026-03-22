// agent/src/prompt-context.ts
import { buildSystemPrompt, type LoadedAgent, loadAgent } from "@devops-agent/gitagent-bridge";
import { getAgentsDir } from "./paths.ts";

let cachedAgent: LoadedAgent | null = null;

function getAgent(): LoadedAgent {
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

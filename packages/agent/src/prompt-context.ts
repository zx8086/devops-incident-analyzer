// agent/src/prompt-context.ts
import { loadAgent, buildSystemPrompt, type LoadedAgent } from "@devops-agent/gitagent-bridge";
import { join } from "node:path";

const AGENTS_DIR = join(import.meta.dir, "../../../agents/incident-analyzer");

let cachedAgent: LoadedAgent | null = null;

function getAgent(): LoadedAgent {
  if (!cachedAgent) {
    cachedAgent = loadAgent(AGENTS_DIR);
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

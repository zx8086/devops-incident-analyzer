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

// SIO-640: runbook filter semantics for the orchestrator prompt.
//   runbookFilter undefined -> no filter (current behavior; all runbooks present)
//   runbookFilter []        -> filter to zero runbooks (suppress all; other categories unchanged)
//   runbookFilter [names]   -> filter to just these runbook filenames
export interface OrchestratorPromptOptions {
	runbookFilter?: string[];
}

export function buildOrchestratorPrompt(options: OrchestratorPromptOptions = {}): string {
	const agent = getAgent();
	const filter = options.runbookFilter;

	if (filter === undefined) {
		return buildSystemPrompt(agent) + buildComplianceBoundary();
	}

	// Filter the knowledge array to remove non-selected runbooks. Other
	// categories (systems-map, slo-policies) pass through unchanged. Shallow
	// copy preserves referential equality for everything else so downstream
	// consumers see the same identities as the cached agent.
	const filterSet = new Set(filter);
	const filteredKnowledge = agent.knowledge.filter((entry) => {
		if (entry.category !== "runbooks") return true;
		return filterSet.has(entry.filename);
	});

	const filteredAgent = { ...agent, knowledge: filteredKnowledge };
	return buildSystemPrompt(filteredAgent) + buildComplianceBoundary();
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

export function getRunbookFilenames(): string[] {
	const agent = getAgent();
	return agent.knowledge.filter((k) => k.category === "runbooks").map((k) => k.filename);
}

// SIO-640: Runbook catalog projection for the lazy selector. Parses each
// runbook's first H1 as title and first non-empty paragraph as summary.
export interface RunbookCatalogEntry {
	filename: string;
	title: string;
	summary: string;
}

export function getRunbookCatalog(): RunbookCatalogEntry[] {
	const agent = getAgent();
	return agent.knowledge
		.filter((k) => k.category === "runbooks")
		.map((k) => parseRunbookCatalogEntry(k.filename, k.content));
}

function parseRunbookCatalogEntry(filename: string, content: string): RunbookCatalogEntry {
	const lines = content.split("\n");
	let title = filename.replace(/\.md$/, "");
	let h1Index = -1;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (line === undefined) continue;
		const match = line.match(/^#\s+(.+)$/);
		if (match?.[1]) {
			title = match[1].trim();
			h1Index = i;
			break;
		}
	}
	let summary = "";
	for (let i = h1Index + 1; i < lines.length; i++) {
		const line = lines[i];
		if (line === undefined) continue;
		const trimmed = line.trim();
		if (trimmed === "") continue;
		if (trimmed.startsWith("#")) break;
		summary = trimmed;
		break;
	}
	if (summary.length > 200) summary = `${summary.slice(0, 197)}...`;
	return { filename, title, summary };
}

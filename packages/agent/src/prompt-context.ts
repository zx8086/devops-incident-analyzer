// agent/src/prompt-context.ts
import {
	buildSystemPrompt,
	type LoadedAgent,
	loadAgent,
	type RunbookTriggers,
	requiresApproval,
	type ToolDefinition,
} from "@devops-agent/gitagent-bridge";
import { buildGraphSection } from "./graph-section.ts";
import { readLiveMemory } from "./memory-writer.ts";
import { getAgentsDir } from "./paths.ts";
import { buildWikiSection, type WikiFocus } from "./wiki/reader.ts";

// SIO-845: cap how many key-decisions tail entries are inlined into the prompt
// so durable memory growth does not blow the context budget.
const MAX_KEY_DECISION_CHARS = 4000;

// Name-keyed registry so a second agent (elastic-iac) can be loaded alongside the
// incident-analyzer without disturbing the existing nodes, which call getAgent().
const agentRegistry = new Map<string, LoadedAgent>();

export function getAgentByName(name: string): LoadedAgent {
	let agent = agentRegistry.get(name);
	if (!agent) {
		agent = loadAgent(getAgentsDir(name));
		agentRegistry.set(name, agent);
	}
	return agent;
}

const DEFAULT_AGENT = "incident-analyzer";

export function getAgent(): LoadedAgent {
	return getAgentByName(DEFAULT_AGENT);
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

// SIO-845: Build the live-memory section appended to the orchestrator prompt.
// Inlines durable context.md plus the tail of key-decisions.md (bounded). Empty
// string when live memory is disabled/absent so the happy path is unchanged.
export function buildLiveMemorySection(): string {
	const memory = readLiveMemory();
	const sections: string[] = [];

	if (memory.context?.trim()) {
		sections.push(memory.context.trim());
	}

	if (memory.keyDecisions?.trim()) {
		// Inline only the tail so the prompt stays bounded as decisions accumulate.
		const full = memory.keyDecisions.trim();
		const tail = full.length > MAX_KEY_DECISION_CHARS ? `...\n${full.slice(-MAX_KEY_DECISION_CHARS)}` : full;
		sections.push(`### Recent Key Decisions\n\n${tail}`);
	}

	if (sections.length === 0) return "";
	return ["\n\n---\n\n## Live Memory", ...sections].join("\n\n");
}

// SIO-640: runbook filter semantics for the orchestrator prompt.
//   runbookFilter undefined -> no filter (current behavior; all runbooks present)
//   runbookFilter []        -> filter to zero runbooks (suppress all; other categories unchanged)
//   runbookFilter [names]   -> filter to just these runbook filenames
export interface OrchestratorPromptOptions {
	runbookFilter?: string[];
	// SIO-847: when provided, the relevant compiled wiki pages (and the index)
	// are inlined into the prompt. Omit for an index-only / no-wiki prompt.
	wikiFocus?: WikiFocus;
	// SIO-850: prior-knowledge context from the knowledge graph (state.graphContext).
	// Already-rendered string; inlined verbatim. Empty when the graph is disabled.
	graphContext?: string;
}

// SIO-847: the wiki section depends on the current turn's focus, so it is built
// per call rather than cached. Empty when no wiki content is relevant/present.
function wikiSectionFor(options: OrchestratorPromptOptions): string {
	const focus = options.wikiFocus ?? { services: [], datasources: [] };
	return buildWikiSection(focus, getAgent());
}

export function buildOrchestratorPrompt(options: OrchestratorPromptOptions = {}): string {
	const agent = getAgent();
	const filter = options.runbookFilter;

	// SIO-1028: prepend a usage instruction to the raw graph block so recall questions
	// answer from prior-incident entries instead of relying on LLM inference. Pure builder
	// lives in graph-section.ts so its unit test dodges the prompt-context.ts module mock.
	const graphSection = buildGraphSection(options.graphContext);

	if (filter === undefined) {
		return (
			buildSystemPrompt(agent) +
			buildComplianceBoundary() +
			buildLiveMemorySection() +
			wikiSectionFor(options) +
			graphSection
		);
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
	return (
		buildSystemPrompt(filteredAgent) +
		buildComplianceBoundary() +
		buildLiveMemorySection() +
		wikiSectionFor(options) +
		graphSection
	);
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

// SIO-1018: the local skill names active in the orchestrator prompt this turn --
// the same set buildSystemPrompt iterates (agent.skills keys). Promoted learned
// skills appear here once added to agent.yaml. Best-effort -> [] if the manifest
// can't be read, so a trace failure never breaks the turn.
export function getActiveSkillNames(): string[] {
	try {
		return [...getAgent().skills.keys()];
	} catch {
		return [];
	}
}

// SIO-640: Runbook catalog projection for the lazy selector. Parses each
// runbook's first H1 as title and first non-empty paragraph as summary.
// SIO-643: Passes through optional frontmatter triggers so the deterministic
// pre-filter can narrow the catalog before the LLM router sees it.
export interface RunbookCatalogEntry {
	filename: string;
	title: string;
	summary: string;
	triggers?: RunbookTriggers;
}

export function getRunbookCatalog(): RunbookCatalogEntry[] {
	const agent = getAgent();
	return agent.knowledge
		.filter((k) => k.category === "runbooks")
		.map((k) => ({
			...parseRunbookCatalogEntry(k.filename, k.content),
			triggers: k.triggers,
		}));
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

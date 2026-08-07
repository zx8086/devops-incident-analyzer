// agent/src/prompt-context.ts
import {
	buildSubAgentSystemPrompt,
	extractSkillToolNames,
	isRunbookCategory,
	type LoadedAgent,
	loadAgent,
	type RunbookTriggers,
	requiresApproval,
	type ToolDefinition,
} from "@devops-agent/gitagent-bridge";
import { buildGraphSection } from "./graph-section.ts";
import {
	assembleOrchestratorPromptParts,
	filterAgentRunbooks,
	type OrchestratorPromptParts,
} from "./orchestrator-prompt-assembly.ts";

export type { OrchestratorPromptParts } from "./orchestrator-prompt-assembly.ts";

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
	// SIO-1204: this turn's derived network-map summary (buildNetworkTopology ->
	// summarizeNetworkTopologyForPrompt). Rendered as its own volatile section with
	// a do-not-reproduce instruction: the full map reaches the user as a card.
	networkContext?: string;
	// SIO-1215: this turn's derived ML anomaly-record summary
	// (buildMlAnomalyExplainer -> summarizeMlAnomalyExplainerForPrompt).
	mlAnomalyContext?: string;
	// SIO-1305: this turn's fused downstream-impact enumeration (KG DEPENDS_ON
	// runtime radius + Orbit code radius). Already-rendered string; inlined
	// verbatim. Empty when the graph is disabled or no dependents are known.
	downstreamImpactContext?: string;
}

function buildNetworkSection(networkContext: string | undefined): string {
	if (!networkContext) return "";
	return `\n\n## Network Map (derived this turn)\n${networkContext}\nMention the network path in the report only where it bears on the root cause; the full map is rendered to the user as an interactive card -- do not reproduce it in the report body.\n`;
}

function buildMlAnomalySection(mlAnomalyContext: string | undefined): string {
	if (!mlAnomalyContext) return "";
	return `\n\n## ML Anomaly Records (derived this turn)\n${mlAnomalyContext}\nMention anomaly findings in the report only where they bear on the root cause; the full detail reaches the user as an interactive card -- do not reproduce it in the report body.\n`;
}

// SIO-1305: the KG DEPENDS_ON runtime radius fused with Orbit's code radius, as a
// deterministic enumeration -- never LLM-router discretion on whether it appears.
function buildDownstreamImpactSection(downstreamImpactContext: string | undefined): string {
	if (!downstreamImpactContext) return "";
	return `\n\n## Downstream Impact (derived this turn)\n${downstreamImpactContext}\nThis enumeration is deterministic, not inferred -- report it as given, and prefer CONFIRMED (two-source) entries over single-source ones when summarizing.\n`;
}

// SIO-847: the wiki section depends on the current turn's focus, so it is built
// per call rather than cached. Empty when no wiki content is relevant/present.
function wikiSectionFor(options: OrchestratorPromptOptions): string {
	const focus = options.wikiFocus ?? { services: [], datasources: [] };
	return buildWikiSection(focus, getAgent());
}

// SIO-1040: stable/volatile split for Bedrock prompt caching. The pure assembly
// (knowledge filter + section ordering) lives in orchestrator-prompt-assembly.ts
// so its byte-identity unit test dodges the process-global prompt-context.ts mock.
// This wrapper only gathers the turn-varying sections (which need getAgent + IO).
export function buildOrchestratorPromptParts(options: OrchestratorPromptOptions = {}): OrchestratorPromptParts {
	const agent = filterAgentRunbooks(getAgent(), options.runbookFilter);
	return assembleOrchestratorPromptParts(agent, {
		compliance: buildComplianceBoundary(),
		liveMemory: buildLiveMemorySection(),
		wiki: wikiSectionFor(options),
		// SIO-1028: prepend a usage instruction to the raw graph block so recall
		// questions answer from prior-incident entries instead of LLM inference.
		graph: buildGraphSection(options.graphContext),
		network: buildNetworkSection(options.networkContext),
		mlAnomaly: buildMlAnomalySection(options.mlAnomalyContext),
		downstreamImpact: buildDownstreamImpactSection(options.downstreamImpactContext),
	});
}

export function buildOrchestratorPrompt(options: OrchestratorPromptOptions = {}): string {
	const { stable, volatile } = buildOrchestratorPromptParts(options);
	return stable + volatile;
}

export function buildSubAgentPrompt(agentName: string): string {
	const rootAgent = getAgent();
	const subAgent = rootAgent.subAgents.get(agentName);
	// SIO-1257: BOTH branches get the non-interactive preamble, including the undeclared-directory
	// fallback. That agent is still dispatched as a sub-agent, still has no human to answer it, and
	// (SIO-1229) is the case most likely to be misconfigured in the first place -- gating on a
	// LoadedAgent flag instead would silently drop the preamble on exactly that path, because the
	// root agent's flag would be false.
	if (!subAgent) return buildSubAgentSystemPrompt(rootAgent);
	return buildSubAgentSystemPrompt(subAgent);
}

export function getToolDefinitionForDataSource(dataSourceId: string): ToolDefinition | undefined {
	const agent = getAgent();
	return agent.tools.find((t) => t.tool_mapping?.mcp_server === dataSourceId);
}

export function getRunbookFilenames(): string[] {
	const agent = getAgent();
	return agent.knowledge.filter((k) => isRunbookCategory(k.category)).map((k) => k.filename);
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

// SIO-1228: the tool names a sub-agent's skill prose promises the model it can call.
// buildSubAgentPrompt injects EVERY skill body on every turn (no activeSkills filter), so
// this set is static per process -- memoized here rather than re-scanned per dispatch.
// Best-effort like getActiveSkillNames: an unreadable manifest degrades to no unioning
// (today's behaviour), never a broken turn.
const skillToolNameCache = new Map<string, string[]>();

export function getSkillToolNames(agentName: string): string[] {
	const cached = skillToolNameCache.get(agentName);
	if (cached) return cached;
	let names: string[] = [];
	try {
		const rootAgent = getAgent();
		// MUST mirror buildSubAgentPrompt's fallback exactly: a sub-agent directory that is
		// not declared in the orchestrator's `agents:` map is absent from subAgents, and the
		// prompt builder then falls back to the ROOT agent -- so the ROOT agent's skills are
		// what gets promised. Resolving to [] here would leave those promises unbound,
		// recreating the very divergence this fixes. (SIO-1229 declares the two agents that
		// hit this path today; the mirror stays correct either way.)
		names = extractSkillToolNames(rootAgent.subAgents.get(agentName) ?? rootAgent);
	} catch {
		names = [];
	}
	skillToolNameCache.set(agentName, names);
	return names;
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
	// SIO-1287: OKF lifecycle metadata, consumed by filterCatalogByLifecycle in
	// runbook-selector.ts. Absent `status` means `stable` per the OKF spec.
	status?: "draft" | "stable" | "deprecated";
	staleAfter?: string;
}

export function getRunbookCatalog(): RunbookCatalogEntry[] {
	const agent = getAgent();
	return agent.knowledge
		.filter((k) => isRunbookCategory(k.category))
		.map((k) => ({
			...parseRunbookCatalogEntry(k.filename, k.content),
			triggers: k.triggers,
			status: k.status,
			staleAfter: k.staleAfter,
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

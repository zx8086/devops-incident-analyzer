// agent/src/supervisor.ts

import { getLogger } from "@devops-agent/observability";
import { DATA_SOURCE_IDS, isKillSwitchActive } from "@devops-agent/shared";
import { Send } from "@langchain/langgraph";
import { getToolsForDataSource } from "./mcp-bridge.ts";
import { getAgent } from "./prompt-context.ts";
import type { AgentStateType } from "./state.ts";

const logger = getLogger("agent:supervisor");

const AGENT_NAMES: Record<string, string> = {
	elastic: "elastic-agent",
	kafka: "kafka-agent",
	couchbase: "capella-agent",
	konnect: "konnect-agent",
	gitlab: "gitlab-agent",
};

type DelegationMode = "auto" | "explicit" | "router";

function getDelegationMode(): DelegationMode {
	try {
		return getAgent().manifest.delegation?.mode ?? "auto";
	} catch {
		return "auto";
	}
}

export function supervise(state: AgentStateType): Send[] {
	// SIO-637: Kill switch halts all sub-agent dispatch
	if (isKillSwitchActive()) {
		logger.warn("Kill switch active, halting sub-agent dispatch");
		return [];
	}

	const delegationMode = getDelegationMode();
	let targetSources = state.targetDataSources;
	let sourceMethod = "ui-selected";

	// Priority 1: UI-selected datasources (if any)
	if (targetSources.length === 0) {
		// Priority 2+3: use extracted entities (already set by entity-extractor)
		targetSources = state.extractedEntities.dataSources.map((d) => d.id);
		sourceMethod = "entity-extracted";
	}

	// SIO-633: Router mode filters out low-confidence "fallback-all" extractions.
	// The entity extractor sets mentionedAs to "all" when no specific datasource was
	// identified -- router mode only dispatches confidently-identified sources.
	if (delegationMode === "router" && sourceMethod === "entity-extracted") {
		const confident = state.extractedEntities.dataSources.filter((d) => d.mentionedAs !== "all");
		if (confident.length > 0) {
			targetSources = [...new Set(confident.map((d) => d.id))];
			sourceMethod = "router-filtered";
		}
	}

	// Priority 4: fallback to all datasources
	if (targetSources.length === 0) {
		targetSources = [...DATA_SOURCE_IDS];
		sourceMethod = delegationMode === "router" ? "router-fallback-all" : "fallback-all";
	}

	// Deduplicate, validate agent name, and skip datasources with no connected MCP tools
	const deduped = [...new Set(targetSources)];
	const toolCounts = new Map(deduped.map((id) => [id, getToolsForDataSource(id).length]));
	const skipped = deduped.filter((id) => !AGENT_NAMES[id] || toolCounts.get(id) === 0);
	const validSources = deduped.filter((id) => AGENT_NAMES[id] && (toolCounts.get(id) ?? 0) > 0);

	// SIO-626: Build human-readable skip reasons for the aggregator
	const skipReasons = skipped.map((id) => {
		if (!AGENT_NAMES[id]) return `${id}: unknown datasource`;
		if (toolCounts.get(id) === 0) return `${id}: MCP server not connected`;
		return `${id}: skipped`;
	});

	logger.info(
		{
			delegationMode,
			sourceMethod,
			requested: deduped,
			dispatching: validSources,
			skipped: skipped.length > 0 ? skipped : undefined,
			toolCounts: Object.fromEntries(validSources.map((id) => [id, toolCounts.get(id)])),
		},
		"Supervisor dispatching sub-agents",
	);

	const skippedState = skipReasons.length > 0 ? { skippedDataSources: skipReasons } : {};

	return validSources.map(
		(dataSourceId) =>
			new Send("queryDataSource", {
				...state,
				...skippedState,
				currentDataSource: dataSourceId,
				dataSourceResults: [],
			}),
	);
}

// agent/src/supervisor.ts

import { getLogger } from "@devops-agent/observability";
import { DATA_SOURCE_IDS } from "@devops-agent/shared";
import { Send } from "@langchain/langgraph";
import { getToolsForDataSource } from "./mcp-bridge.ts";
import type { AgentStateType } from "./state.ts";

const logger = getLogger("agent:supervisor");

const AGENT_NAMES: Record<string, string> = {
	elastic: "elastic-agent",
	kafka: "kafka-agent",
	couchbase: "capella-agent",
	konnect: "konnect-agent",
};

export function supervise(state: AgentStateType): Send[] {
	let targetSources = state.targetDataSources;
	let sourceMethod = "ui-selected";

	// Priority 1: UI-selected datasources (if any)
	if (targetSources.length === 0) {
		// Priority 2+3: use extracted entities (already set by entity-extractor)
		targetSources = state.extractedEntities.dataSources.map((d) => d.id);
		sourceMethod = "entity-extracted";
	}

	// Priority 4: fallback to all datasources
	if (targetSources.length === 0) {
		targetSources = [...DATA_SOURCE_IDS];
		sourceMethod = "fallback-all";
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

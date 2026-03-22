// agent/src/supervisor.ts
import { Send } from "@langchain/langgraph";
import type { AgentStateType } from "./state.ts";
import { DATA_SOURCE_IDS } from "@devops-agent/shared";

const AGENT_NAMES: Record<string, string> = {
  elastic: "elastic-agent",
  kafka: "kafka-agent",
  couchbase: "capella-agent",
  konnect: "konnect-agent",
};

export function supervise(state: AgentStateType): Send[] {
  let targetSources = state.targetDataSources;

  // Priority 1: UI-selected datasources (if any)
  if (targetSources.length === 0) {
    // Priority 2+3: use extracted entities (already set by entity-extractor)
    targetSources = state.extractedEntities.dataSources.map((d) => d.id);
  }

  // Priority 4: fallback to all datasources
  if (targetSources.length === 0) {
    targetSources = [...DATA_SOURCE_IDS];
  }

  // Deduplicate and validate
  const validSources = [...new Set(targetSources)].filter((id) => AGENT_NAMES[id]);

  return validSources.map(
    (dataSourceId) =>
      new Send("queryDataSource", {
        ...state,
        currentDataSource: dataSourceId,
        dataSourceResults: [],
      }),
  );
}

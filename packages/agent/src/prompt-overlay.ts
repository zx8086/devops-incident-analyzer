// agent/src/prompt-overlay.ts
// SIO-576: Layer gitagent dynamic prompts onto existing MCP server tools
import { loadAgent, buildAllToolPrompts, buildRelatedToolsMap } from "@devops-agent/gitagent-bridge";
import { join } from "node:path";

const AGENTS_DIR = join(import.meta.dir, "../../../agents/incident-analyzer");

let cachedToolPrompts: Map<string, string> | null = null;
let cachedRelatedToolsMap: Map<string, string[]> | null = null;

// Mapping from gitagent YAML tool names to MCP server tool name patterns
const TOOL_NAME_MAP: Record<string, string[]> = {
  "elastic-search-logs": ["elasticsearch_search", "elasticsearch_execute_sql_query", "elasticsearch_get_cluster_health"],
  "kafka-introspect": ["kafka_list_topics", "kafka_get_consumer_group_lag", "kafka_consume_messages", "kafka_describe_topic"],
  "couchbase-cluster-health": ["get_system_vitals", "get_system_nodes", "get_fatal_requests", "get_longest_running_queries"],
  "konnect-api-gateway": ["query_api_requests", "list_services", "list_routes", "list_plugins", "list_control_planes"],
};

export function getToolPrompts(): Map<string, string> {
  if (!cachedToolPrompts) {
    const agent = loadAgent(AGENTS_DIR);
    cachedToolPrompts = buildAllToolPrompts(agent, {
      datasources: ["elastic", "kafka", "couchbase", "konnect"],
    });
  }
  return cachedToolPrompts;
}

export function getRelatedToolsMap(): Map<string, string[]> {
  if (!cachedRelatedToolsMap) {
    const agent = loadAgent(AGENTS_DIR);
    cachedRelatedToolsMap = buildRelatedToolsMap(agent);
  }
  return cachedRelatedToolsMap;
}

export function getEnhancedDescription(mcpToolName: string): string | undefined {
  const prompts = getToolPrompts();

  // Check if any gitagent tool maps to this MCP tool
  for (const [gitagentName, mcpNames] of Object.entries(TOOL_NAME_MAP)) {
    if (mcpNames.includes(mcpToolName)) {
      return prompts.get(gitagentName);
    }
  }

  return undefined;
}

// apps/web/src/lib/server/agent.ts
import { buildGraph, createMcpClient } from "@devops-agent/agent";

let graphPromise: ReturnType<typeof buildGraph> | null = null;

export async function getGraph() {
  if (!graphPromise) {
    await createMcpClient({
      elasticUrl: process.env.ELASTIC_MCP_URL,
      kafkaUrl: process.env.KAFKA_MCP_URL,
      capellaUrl: process.env.COUCHBASE_MCP_URL,
      konnectUrl: process.env.KONNECT_MCP_URL,
    });

    graphPromise = buildGraph({
      checkpointerType: (process.env.AGENT_CHECKPOINTER_TYPE as "memory" | "sqlite") ?? "memory",
    });
  }
  return graphPromise;
}

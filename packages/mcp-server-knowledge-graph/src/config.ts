// src/config.ts
import { z } from "zod";

// Per project rules, no .default() inside the schema; the loader supplies explicit
// env fallbacks. This server is READ-ONLY: curated graph readers plus an optional,
// env-gated raw-Cypher tool guarded to reject any write/DDL keyword.
export const ConfigSchema = z.object({
	transport: z.object({
		mode: z.enum(["http", "stdio"]),
		port: z.number().int().positive(),
		host: z.string(),
		path: z.string(),
	}),
	// SIO-967: the graph is opened in-process via getGraphStore() (one lbug lock
	// holder per process); the path here is only surfaced for the readiness probe
	// and identity fingerprint. The store itself reads KNOWLEDGE_GRAPH_PATH.
	graphPath: z.string(),
	knowledgeGraphEnabled: z.boolean(),
	// SIO-967: raw Cypher is ON by default (set KG_MCP_ALLOW_CYPHER=false to disable).
	// The kg_run_cypher tool carries a read-only keyword guard (rejects CREATE/MERGE/
	// SET/DELETE/DETACH/DROP/ALTER/COPY/CALL + multi-statement payloads), binds all
	// values as params, and its description embeds the graph schema so the agent can
	// write correct queries. Curated kg_* tools are always registered regardless.
	allowCypher: z.boolean(),
});

export type Config = z.infer<typeof ConfigSchema>;

// SIO-986: use process.env (NOT Bun.env) -- this server is mounted IN-PROCESS in the web app's
// Vite SSR runtime, where the Bun global does not exist. process.env works in both Bun and SSR
// (Bun aliases the two). Reading Bun.env here threw "Bun is not defined" and crashed the app.
export function loadConfig(): Config {
	return ConfigSchema.parse({
		transport: {
			mode: (process.env.KNOWLEDGE_GRAPH_MCP_TRANSPORT as "http" | "stdio") ?? "http",
			port: Number(process.env.KNOWLEDGE_GRAPH_MCP_PORT ?? "9087"),
			host: process.env.KNOWLEDGE_GRAPH_MCP_HOST ?? "0.0.0.0",
			path: process.env.KNOWLEDGE_GRAPH_MCP_PATH ?? "/mcp",
		},
		graphPath: process.env.KNOWLEDGE_GRAPH_PATH || ".data/knowledge-graph",
		// SIO-968: default ON. The KG MCP server only runs when it is meant to serve the
		// graph, so its tools should treat the graph as enabled unless explicitly disabled
		// (KNOWLEDGE_GRAPH_ENABLED=false/0). This is the server-layer default; the shared
		// fleet-wide isKnowledgeGraphEnabled() gate (graph WRITES in the pipeline) is left
		// default-off so lbug-absent deployments keep their safe no-op.
		knowledgeGraphEnabled:
			process.env.KNOWLEDGE_GRAPH_ENABLED !== "false" && process.env.KNOWLEDGE_GRAPH_ENABLED !== "0",
		// Default ON; only an explicit "false"/"0" disables raw Cypher.
		allowCypher: process.env.KG_MCP_ALLOW_CYPHER !== "false" && process.env.KG_MCP_ALLOW_CYPHER !== "0",
	});
}

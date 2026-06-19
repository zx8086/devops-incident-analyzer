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
	// SIO-967: raw Cypher is OFF by default. When true, the kg_run_cypher tool is
	// registered with a read-only keyword guard (rejects CREATE/MERGE/SET/DELETE/
	// DETACH/DROP/ALTER/COPY/CALL). Curated tools are always registered.
	allowCypher: z.boolean(),
});

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(): Config {
	return ConfigSchema.parse({
		transport: {
			mode: (Bun.env.KNOWLEDGE_GRAPH_MCP_TRANSPORT as "http" | "stdio") ?? "http",
			port: Number(Bun.env.KNOWLEDGE_GRAPH_MCP_PORT ?? "9087"),
			host: Bun.env.KNOWLEDGE_GRAPH_MCP_HOST ?? "0.0.0.0",
			path: Bun.env.KNOWLEDGE_GRAPH_MCP_PATH ?? "/mcp",
		},
		graphPath: Bun.env.KNOWLEDGE_GRAPH_PATH || ".data/knowledge-graph",
		knowledgeGraphEnabled: Bun.env.KNOWLEDGE_GRAPH_ENABLED === "true" || Bun.env.KNOWLEDGE_GRAPH_ENABLED === "1",
		allowCypher: Bun.env.KG_MCP_ALLOW_CYPHER === "true" || Bun.env.KG_MCP_ALLOW_CYPHER === "1",
	});
}

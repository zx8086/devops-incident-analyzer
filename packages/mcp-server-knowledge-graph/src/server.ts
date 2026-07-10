// src/server.ts
import { createCachedServerFactory } from "@devops-agent/shared";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import pkg from "../package.json" with { type: "json" };
import type { Config } from "./config.ts";
import { registerCuratedTools } from "./tools/curated.ts";
import { registerCypherTool } from "./tools/cypher.ts";

// Sync -- allocates a bare McpServer with capabilities/description but NO tools.
function createBareServer(): McpServer {
	return new McpServer({
		name: "knowledge-graph-mcp-server",
		version: pkg.version,
		// SIO-967: read-only query surface over the infrastructure knowledge graph
		// (three-layer Module/Stack/Deployment/StackInstance + change history). Curated
		// tools always; raw read-only Cypher only when KG_MCP_ALLOW_CYPHER=true. Never
		// writes -- the graph is populated by the agent pipeline's record* nodes.
		description:
			"Read-only knowledge-graph queries: blast radius (deployments running a stack, stacks using a module) and change history (per deployment / per stack-instance). Optional gated read-only Cypher. Never writes.",
	});
}

// SIO-968: tools gate on the server's startup config, not a per-call process.env
// re-read (which diverged under --env-file and falsely reported "disabled"). These
// gates are boot-config by design -- do not change them.
function registerAll(server: McpServer, config: Config): void {
	registerCuratedTools(server, config.knowledgeGraphEnabled);
	if (config.allowCypher) registerCypherTool(server, config.knowledgeGraphEnabled);
}

// SIO-1044: record-once / replay-many factory. registerAll (sync, config-only) runs ONCE at
// boot; each request replays the recorded tool triples onto a fresh bare server.
export function createMcpServerFactory(config: Config): () => McpServer {
	return createCachedServerFactory({
		createBareServer: () => createBareServer(),
		registerAll: (server) => registerAll(server, config),
	});
}

// Sync -- creates a fresh McpServer and registers all tools on it. Kept for back-compat
// (any caller that wants a one-off instance without the factory).
export function createServer(config: Config): McpServer {
	const server = createBareServer();
	registerAll(server, config);
	return server;
}

// src/server.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import pkg from "../package.json" with { type: "json" };
import type { Config } from "./config.ts";
import { registerCuratedTools } from "./tools/curated.ts";
import { registerCypherTool } from "./tools/cypher.ts";

export function createServer(config: Config): McpServer {
	const server = new McpServer({
		name: "knowledge-graph-mcp-server",
		version: pkg.version,
		// SIO-967: read-only query surface over the infrastructure knowledge graph
		// (three-layer Module/Stack/Deployment/StackInstance + change history). Curated
		// tools always; raw read-only Cypher only when KG_MCP_ALLOW_CYPHER=true. Never
		// writes -- the graph is populated by the agent pipeline's record* nodes.
		description:
			"Read-only knowledge-graph queries: blast radius (deployments running a stack, stacks using a module) and change history (per deployment / per stack-instance). Optional gated read-only Cypher. Never writes.",
	});

	registerCuratedTools(server);
	if (config.allowCypher) registerCypherTool(server);

	return server;
}

// src/server.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "./config/index.js";
import type { GitLabRestClient } from "./gitlab-client/index.js";
import type { GitLabMcpProxy, ProxyToolInfo } from "./gitlab-client/proxy.js";
import { registerCodeAnalysisTools } from "./tools/code-analysis-registry.js";
import { registerProxyTools } from "./tools/proxy/index.js";
import { createContextLogger } from "./utils/logger.js";

const log = createContextLogger("server");

export interface GitLabDatasource {
	proxy: GitLabMcpProxy;
	restClient: GitLabRestClient;
	config: Config;
	discoveredTools?: ProxyToolInfo[];
}

// Discover remote tools once at startup (async)
export async function discoverRemoteTools(proxy: GitLabMcpProxy): Promise<ProxyToolInfo[]> {
	try {
		const tools = await proxy.listTools();
		log.info({ toolCount: tools.length }, "Discovered remote GitLab MCP tools");
		return tools;
	} catch (error) {
		log.warn(
			{ error: error instanceof Error ? error.message : String(error) },
			"Failed to discover proxy tools -- proxy tools will be unavailable",
		);
		return [];
	}
}

// Create a new McpServer instance with all tools registered (sync)
export function createGitLabServer(datasource: GitLabDatasource): McpServer {
	const { config, proxy, restClient, discoveredTools } = datasource;

	const server = new McpServer({
		name: config.application.name,
		version: config.application.version,
	});

	// Register proxy tools from pre-discovered tool list
	let proxyCount = 0;
	if (discoveredTools && discoveredTools.length > 0) {
		proxyCount = registerProxyTools(server, proxy, discoveredTools, restClient);
	}

	// Register code analysis tools via REST API
	const codeAnalysisCount = registerCodeAnalysisTools(server, restClient);

	log.info(
		{ proxyTools: proxyCount, codeAnalysisTools: codeAnalysisCount, total: proxyCount + codeAnalysisCount },
		"GitLab MCP server created",
	);

	return server;
}

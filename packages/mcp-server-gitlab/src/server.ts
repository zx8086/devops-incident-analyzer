// src/server.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "./config/index.js";
import type { GitLabRestClient } from "./gitlab-client/index.js";
import type { GitLabMcpProxy, ProxyToolInfo } from "./gitlab-client/proxy.js";
import { registerCodeAnalysisTools } from "./tools/code-analysis-registry.js";
import { registerProxyTools } from "./tools/proxy/index.js";
import { createContextLogger } from "./utils/logger.js";

const log = createContextLogger("server");

// SIO-703: in HTTP stateless mode, createServerFactory fires per request, so the
// "MCP server created" log fired N times per tool call and polluted the trace
// timeline. The factory's output is identical across requests (discoveredTools
// is captured once at startup), so logging once on the first invocation gives
// operators the same visibility without the per-request noise.
let serverCreatedLogged = false;

export function _resetServerCreatedLoggedForTest(): void {
	serverCreatedLogged = false;
}

export function _isServerCreatedLoggedForTest(): boolean {
	return serverCreatedLogged;
}

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

	if (!serverCreatedLogged) {
		log.info(
			{ proxyTools: proxyCount, codeAnalysisTools: codeAnalysisCount, total: proxyCount + codeAnalysisCount },
			"GitLab MCP server created",
		);
		serverCreatedLogged = true;
	}

	return server;
}

// src/server.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AtlassianMcpProxy, ProxyToolInfo } from "./atlassian-client/index.js";
import type { Config } from "./config/index.js";
import { registerCustomTools } from "./tools/custom/index.js";
import { registerProxyTools } from "./tools/proxy/index.js";
import { createContextLogger } from "./utils/logger.js";

const log = createContextLogger("server");

// SIO-703: in HTTP stateless mode, createServerFactory fires per request, so the
// "MCP server created" log fired N times per tool call and polluted the trace
// timeline. The factory's output is identical across requests (discoveredTools
// is captured once at startup), so logging once on the first invocation gives
// operators the same visibility without the per-request noise.
let serverCreatedLogged = false;

export interface AtlassianDatasource {
	proxy: AtlassianMcpProxy;
	config: Config;
	discoveredTools: ProxyToolInfo[];
	siteUrl?: string;
}

export async function discoverRemoteTools(proxy: AtlassianMcpProxy): Promise<ProxyToolInfo[]> {
	try {
		const tools = await proxy.listTools();
		log.info({ toolCount: tools.length, names: tools.map((t) => t.name) }, "Discovered remote Atlassian MCP tools");
		return tools;
	} catch (error) {
		log.warn(
			{ error: error instanceof Error ? error.message : String(error) },
			"Failed to discover proxy tools -- proxy tools will be unavailable",
		);
		return [];
	}
}

export function createAtlassianServer(ds: AtlassianDatasource): McpServer {
	const { config, proxy, discoveredTools, siteUrl } = ds;
	const server = new McpServer({
		name: config.application.name,
		version: config.application.version,
	});

	const { registered, filtered } = registerProxyTools(server, proxy, discoveredTools, {
		readOnly: config.atlassian.readOnly,
	});
	const customCount = registerCustomTools(server, proxy, {
		incidentProjects: config.atlassian.incidentProjects,
		siteUrl,
	});

	if (!serverCreatedLogged) {
		log.info(
			{ proxyRegistered: registered, proxyFiltered: filtered, customCount, total: registered + customCount },
			"Atlassian MCP server created",
		);
		serverCreatedLogged = true;
	}
	return server;
}

// SIO-703: test seam. Tests can reset the once-flag between cases without
// reaching for module-cache invalidation, and inspect the flag state to
// confirm logging suppression occurred.
export function _resetServerCreatedLoggedForTest(): void {
	serverCreatedLogged = false;
}

export function _isServerCreatedLoggedForTest(): boolean {
	return serverCreatedLogged;
}

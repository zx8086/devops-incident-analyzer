// src/server.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AtlassianMcpProxy, ProxyToolInfo } from "./atlassian-client/index.js";
import type { Config } from "./config/index.js";
import { registerCustomTools } from "./tools/custom/index.js";
import { registerProxyTools } from "./tools/proxy/index.js";
import { createContextLogger } from "./utils/logger.js";

const log = createContextLogger("server");

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

	log.info(
		{ proxyRegistered: registered, proxyFiltered: filtered, customCount, total: registered + customCount },
		"Atlassian MCP server created",
	);
	return server;
}

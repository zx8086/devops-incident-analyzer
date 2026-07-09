// src/server.ts
import { createCachedServerFactory } from "@devops-agent/shared";
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

// Sync -- allocates a bare McpServer with capabilities/instructions but NO tools.
function createBareServer(config: Config): McpServer {
	return new McpServer({
		name: config.application.name,
		version: config.application.version,
	});
}

// discoveredTools is a boot-time snapshot (initDatasource discovers it once via
// discoverRemoteTools), so iterating the frozen array here is sound under the SIO-1044 factory.
function registerAll(server: McpServer, ds: AtlassianDatasource): void {
	const { config, proxy, discoveredTools, siteUrl } = ds;
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
}

// SIO-1044: record-once / replay-many factory. registerAll runs ONCE at boot (against the
// datasource's frozen discoveredTools snapshot); each request replays the recorded tool tuples
// onto a fresh bare server. The "Atlassian MCP server created" log now fires once, at boot,
// making the SIO-703 once-flag redundant.
export function createMcpServerFactory(ds: AtlassianDatasource): () => McpServer {
	return createCachedServerFactory({
		createBareServer: () => createBareServer(ds.config),
		registerAll: (server) => registerAll(server, ds),
	});
}

// src/server.ts
import { createCachedServerFactory } from "@devops-agent/shared";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "./config/index.js";
import type { GitLabRestClient } from "./gitlab-client/index.js";
import type { OrbitRestClient } from "./gitlab-client/orbit.js";
import type { GitLabMcpProxy, ProxyToolInfo } from "./gitlab-client/proxy.js";
import { registerCodeAnalysisTools } from "./tools/code-analysis-registry.js";
import { registerOrbitTools } from "./tools/orbit/index.js";
import { registerProxyTools } from "./tools/proxy/index.js";
import { createContextLogger } from "./utils/logger.js";

const log = createContextLogger("server");

export interface GitLabDatasource {
	proxy: GitLabMcpProxy;
	restClient: GitLabRestClient;
	config: Config;
	discoveredTools?: ProxyToolInfo[];
	// SIO-1076: Orbit knowledge-graph REST client + boot-probe state.
	orbitClient?: OrbitRestClient;
	orbitAvailable?: boolean;
	orbitIndexing?: boolean;
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

// Sync -- allocates a bare McpServer with capabilities/instructions but NO tools.
function createBareServer(config: Config): McpServer {
	return new McpServer({
		name: config.application.name,
		version: config.application.version,
	});
}

// discoveredTools is a boot-time snapshot (initDatasource discovers it once via
// discoverRemoteTools), so iterating the frozen array here is sound under the SIO-1044 factory.
// NOTE: if the boot-time proxy connect fails, initDatasource passes discoveredTools=[] and
// registerAll runs (and is cached) against that empty set -- proxy tools stay unavailable until
// the process restarts, same as the pre-SIO-1044 per-request behavior.
function registerAll(server: McpServer, datasource: GitLabDatasource): void {
	const { proxy, restClient, discoveredTools, config } = datasource;

	let proxyCount = 0;
	if (discoveredTools && discoveredTools.length > 0) {
		proxyCount = registerProxyTools(server, proxy, discoveredTools, restClient);
	}

	const codeAnalysisCount = registerCodeAnalysisTools(server, restClient);

	// SIO-1076: Orbit tools register whenever enabled, regardless of boot
	// availability -- the handlers soft-fail so the tool surface stays stable.
	// Optional-chained so a partial Config (e.g. tool-list tests) skips cleanly.
	let orbitCount = 0;
	if (config.orbit?.enabled) {
		orbitCount = registerOrbitTools(server, {
			client: datasource.orbitClient,
			available: datasource.orbitAvailable ?? false,
			indexing: datasource.orbitIndexing ?? false,
			maxQueriesPerRun: config.orbit.maxQueriesPerRun,
			defaultGroupPath: "pvhcorp",
		});
	}

	log.info(
		{
			proxyTools: proxyCount,
			codeAnalysisTools: codeAnalysisCount,
			orbitTools: orbitCount,
			total: proxyCount + codeAnalysisCount + orbitCount,
		},
		"GitLab MCP server created",
	);
}

// SIO-1044: record-once / replay-many factory. registerAll runs ONCE at boot (against the
// datasource's frozen discoveredTools snapshot); each request replays the recorded tool tuples
// onto a fresh bare server. The "GitLab MCP server created" log now fires once, at boot, making
// the SIO-703 once-flag redundant.
export function createMcpServerFactory(datasource: GitLabDatasource): () => McpServer {
	return createCachedServerFactory({
		createBareServer: () => createBareServer(datasource.config),
		registerAll: (server) => registerAll(server, datasource),
	});
}

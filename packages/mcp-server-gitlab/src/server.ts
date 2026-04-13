// src/server.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "./config/index.js";
import type { GitLabRestClient } from "./gitlab-client/index.js";
import type { GitLabMcpProxy } from "./gitlab-client/proxy.js";
import { registerAllTools } from "./tools/index.js";
import { createContextLogger } from "./utils/logger.js";

const log = createContextLogger("server");

export interface GitLabDatasource {
	proxy: GitLabMcpProxy;
	restClient: GitLabRestClient;
	config: Config;
}

export async function createGitLabServer(datasource: GitLabDatasource): Promise<McpServer> {
	const { config, proxy, restClient } = datasource;

	const server = new McpServer({
		name: config.application.name,
		version: config.application.version,
	});

	const { proxyTools, codeAnalysisTools } = await registerAllTools(server, proxy, restClient);

	log.info(
		{
			proxyTools: proxyTools.length,
			codeAnalysisTools: codeAnalysisTools.length,
			total: proxyTools.length + codeAnalysisTools.length,
		},
		"GitLab MCP server created",
	);

	return server;
}

// src/index.ts
import { buildTelemetryConfig, createBootstrapAdapter, createMcpApplication } from "@devops-agent/shared";
import { loadConfiguration } from "./config/index.js";
import { GitLabRestClient } from "./gitlab-client/index.js";
import { GitLabMcpProxy } from "./gitlab-client/proxy.js";
import { createGitLabServer, discoverRemoteTools, type GitLabDatasource } from "./server.ts";
import { createTransport } from "./transport/index.ts";
import { getRuntimeInfo } from "./utils/env.js";
import { createContextLogger, logger } from "./utils/logger.js";
import { initializeTracing } from "./utils/tracing.js";

const serverLog = createContextLogger("server");

if (import.meta.main) {
	createMcpApplication<GitLabDatasource>({
		name: "gitlab-mcp-server",
		logger: createBootstrapAdapter(logger),

		initTracing: () => initializeTracing(),
		telemetry: buildTelemetryConfig("gitlab-mcp-server"),

		initDatasource: async () => {
			const config = await loadConfiguration();

			logger.level = config.application.logLevel;

			const runtimeInfo = getRuntimeInfo();
			serverLog.info(
				{
					runtime: runtimeInfo.runtime,
					version: runtimeInfo.version,
					envSource: runtimeInfo.envSource,
				},
				"Starting GitLab MCP Server",
			);

			const proxy = new GitLabMcpProxy({
				instanceUrl: config.gitlab.instanceUrl,
				personalAccessToken: config.gitlab.personalAccessToken,
				timeout: config.gitlab.timeout,
				oauthCallbackPort: config.gitlab.oauthCallbackPort,
			});

			try {
				await proxy.connect();
			} catch (error) {
				serverLog.warn(
					{ error: error instanceof Error ? error.message : String(error) },
					"Failed to connect to GitLab MCP endpoint -- proxy tools will be unavailable",
				);
			}

			// Discover remote tools once at startup
			const discoveredTools = proxy.isConnected() ? await discoverRemoteTools(proxy) : [];

			const restClient = new GitLabRestClient({
				instanceUrl: config.gitlab.instanceUrl,
				personalAccessToken: config.gitlab.personalAccessToken,
				timeout: config.gitlab.timeout,
			});

			return { proxy, restClient, config, discoveredTools };
		},

		// Sync factory: creates a new McpServer per request with pre-discovered tools
		createServerFactory: (ds) => () => createGitLabServer(ds),

		createTransport: (serverFactory, ds) => createTransport(ds.config.transport, serverFactory),

		cleanupDatasource: async (ds) => {
			await ds.proxy.disconnect();
		},

		onStarted: (ds) => {
			serverLog.info(
				{
					gitlabInstance: ds.config.gitlab.instanceUrl,
					proxyConnected: ds.proxy.isConnected(),
					proxyTools: ds.discoveredTools?.length ?? 0,
					environment: ds.config.application.environment,
					transport: ds.config.transport.mode,
					port: ds.config.transport.mode !== "stdio" ? ds.config.transport.port : undefined,
					tracing: ds.config.tracing.enabled,
				},
				"GitLab MCP Server ready",
			);
		},
	});
}

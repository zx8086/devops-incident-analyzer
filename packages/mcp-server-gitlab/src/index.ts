// src/index.ts
import { buildTelemetryConfig, createBootstrapAdapter, createMcpApplication } from "@devops-agent/shared";
import { loadConfiguration } from "./config/index.js";
import { GitLabRestClient } from "./gitlab-client/index.js";
import { GitLabMcpProxy } from "./gitlab-client/proxy.js";
import { createGitLabServer, type GitLabDatasource } from "./server.ts";
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
			});

			// Connect proxy to GitLab's MCP endpoint -- non-fatal if unavailable
			try {
				await proxy.connect();
			} catch (error) {
				serverLog.warn(
					{ error: error instanceof Error ? error.message : String(error) },
					"Failed to connect to GitLab MCP endpoint -- proxy tools will be unavailable",
				);
			}

			const restClient = new GitLabRestClient({
				instanceUrl: config.gitlab.instanceUrl,
				personalAccessToken: config.gitlab.personalAccessToken,
				timeout: config.gitlab.timeout,
			});

			return { proxy, restClient, config };
		},

		createServerFactory: (ds) => () => {
			// createGitLabServer is async, but createMcpApplication expects sync factory.
			// We return a placeholder and handle async registration in createTransport.
			// This works because our transport factory calls serverFactory as async.
			return createGitLabServer(ds) as unknown as ReturnType<
				() => import("@modelcontextprotocol/sdk/server/mcp.js").McpServer
			>;
		},

		createTransport: async (serverFactory, ds) => {
			// Since our server creation is async (proxy tool discovery), wrap it
			const asyncServerFactory = async () => {
				const result = serverFactory();
				// If it's a promise (from our async createGitLabServer), await it
				if (result && typeof (result as unknown as Promise<unknown>).then === "function") {
					return await (result as unknown as Promise<import("@modelcontextprotocol/sdk/server/mcp.js").McpServer>);
				}
				return result;
			};

			return createTransport(ds.config.transport, asyncServerFactory);
		},

		cleanupDatasource: async (ds) => {
			await ds.proxy.disconnect();
		},

		onStarted: (ds) => {
			serverLog.info(
				{
					gitlabInstance: ds.config.gitlab.instanceUrl,
					proxyConnected: ds.proxy.isConnected(),
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

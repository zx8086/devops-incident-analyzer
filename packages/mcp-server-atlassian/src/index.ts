// src/index.ts
import { buildTelemetryConfig, createBootstrapAdapter, createMcpApplication } from "@devops-agent/shared";
import { AtlassianMcpProxy } from "./atlassian-client/index.js";
import { loadConfiguration } from "./config/index.js";
import { type AtlassianDatasource, createAtlassianServer, discoverRemoteTools } from "./server.js";
import { createTransport } from "./transport/index.js";
import { getRuntimeInfo } from "./utils/env.js";
import { createContextLogger, logger } from "./utils/logger.js";
import { initializeTracing } from "./utils/tracing.js";

const serverLog = createContextLogger("server");

if (import.meta.main) {
	createMcpApplication<AtlassianDatasource>({
		name: "atlassian-mcp-server",
		logger: createBootstrapAdapter(logger),

		initTracing: () => initializeTracing(),
		telemetry: buildTelemetryConfig("atlassian-mcp-server"),

		initDatasource: async () => {
			const config = await loadConfiguration();
			logger.level = config.application.logLevel;

			const runtimeInfo = getRuntimeInfo();
			serverLog.info(
				{ runtime: runtimeInfo.runtime, version: runtimeInfo.version, envSource: runtimeInfo.envSource },
				"Starting Atlassian MCP Server",
			);

			const proxy = new AtlassianMcpProxy({
				mcpEndpoint: config.atlassian.mcpEndpoint,
				callbackPort: config.atlassian.oauthCallbackPort,
				siteName: config.atlassian.siteName,
				timeout: config.atlassian.timeout,
			});

			await proxy.connect();
			await proxy.resolveCloudId();
			const discoveredTools = await discoverRemoteTools(proxy);

			return { proxy, config, discoveredTools, siteUrl: undefined };
		},

		createServerFactory: (ds) => () => createAtlassianServer(ds),

		createTransport: (serverFactory, ds) => createTransport(ds.config.transport, serverFactory),

		cleanupDatasource: async (ds) => {
			await ds.proxy.disconnect();
		},

		onStarted: (ds) => {
			const proxyCount = ds.discoveredTools.length;
			serverLog.info(
				{
					endpoint: ds.config.atlassian.mcpEndpoint,
					cloudId: ds.proxy.getCloudId(),
					site: ds.config.atlassian.siteName,
					proxyTools: proxyCount,
					customTools: 3,
					readOnly: ds.config.atlassian.readOnly,
					transport: ds.config.transport.mode,
					port: ds.config.transport.mode !== "stdio" ? ds.config.transport.port : undefined,
				},
				`Atlassian MCP ready: cloudId=${ds.proxy.getCloudId()}, site=${ds.config.atlassian.siteName ?? "(default)"}, tools=${proxyCount}+3, readOnly=${ds.config.atlassian.readOnly}`,
			);
		},
	});
}

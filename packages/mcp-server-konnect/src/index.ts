// src/index.ts
import { buildTelemetryConfig, createBootstrapAdapter, createMcpApplication } from "@devops-agent/shared";
import { KongApi } from "./api/kong-api.js";
import { type Config, loadConfiguration } from "./config/index.js";
import { createKonnectServer } from "./server.ts";
import { createTransport } from "./transport/index.ts";
import { getRuntimeInfo } from "./utils/env.js";
import { createContextLogger, logger } from "./utils/logger.js";
import { initializeTracing } from "./utils/tracing.js";

const serverLog = createContextLogger("server");

interface KonnectDatasource {
	api: KongApi;
	config: Config;
}

if (import.meta.main) {
	createMcpApplication<KonnectDatasource>({
		name: "konnect-mcp-server",
		logger: createBootstrapAdapter(logger),

		initTracing: () => initializeTracing(),
		telemetry: buildTelemetryConfig("konnect-mcp-server"),

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
				"Starting Konnect MCP Server",
			);

			const api = new KongApi({
				apiKey: config.kong.accessToken,
				apiRegion: config.kong.region,
			});

			return { api, config };
		},

		createServerFactory: (ds) => () => createKonnectServer(ds.api, ds.config),

		// SIO-779: proxy mode is not used for this server; non-null assertion is safe
		// biome-ignore lint/style/noNonNullAssertion: SIO-779 - server mode always provides createServerFactory
		createTransport: (serverFactory, ds) => createTransport(ds.config.transport, serverFactory!),

		onStarted: (ds) => {
			serverLog.info(
				{
					region: ds.config.kong.region,
					environment: ds.config.application.environment,
					transport: ds.config.transport.mode,
					port: ds.config.transport.mode !== "stdio" ? ds.config.transport.port : undefined,
					tracing: ds.config.tracing.enabled,
					monitoring: ds.config.monitoring.enabled,
				},
				"Konnect MCP Server ready",
			);
		},
	});
}

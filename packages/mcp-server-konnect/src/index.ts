// src/index.ts
import { buildTelemetryConfig, createBootstrapAdapter, createMcpApplication } from "@devops-agent/shared";
import { API_REGIONS, KongApi } from "./api/kong-api.js";
import { type Config, loadConfiguration } from "./config/index.js";
import { createKonnectServer } from "./server.ts";
import { createTransport } from "./transport/index.ts";
import { getRuntimeInfo } from "./utils/env.js";
import { createContextLogger, logger } from "./utils/mcp-logger.js";
import { initializeTracing } from "./utils/tracing.js";

const serverLog = createContextLogger("server");

interface KonnectDatasource {
	api: KongApi;
	config: Config;
}

const isMainModule = process.argv[1] && import.meta.url.includes(process.argv[1]);

if (isMainModule) {
	createMcpApplication<KonnectDatasource>({
		name: "konnect-mcp-server",
		logger: createBootstrapAdapter(logger),

		initTracing: () => initializeTracing(),
		telemetry: buildTelemetryConfig("konnect-mcp-server"),

		initDatasource: async () => {
			serverLog.info("Loading configuration");
			const config = await loadConfiguration();

			logger.level = config.application.logLevel;

			const runtimeInfo = getRuntimeInfo();
			serverLog.info(
				{
					runtime: runtimeInfo.runtime,
					version: runtimeInfo.version,
					envSource: runtimeInfo.envSource,
				},
				"Runtime information",
			);

			const api = new KongApi({
				apiKey: config.kong.accessToken,
				apiRegion: config.kong.region,
			});

			return { api, config };
		},

		createServerFactory: (ds) => () => createKonnectServer(ds.api, ds.config),

		createTransport: (serverFactory, ds) => createTransport(ds.config, serverFactory),

		onStarted: (ds) => {
			serverLog.info(
				{
					availableRegions: Object.values(API_REGIONS),
					region: ds.config.kong.region,
					environment: ds.config.application.environment,
					logLevel: ds.config.application.logLevel,
					tracing: ds.config.tracing.enabled,
					monitoring: ds.config.monitoring.enabled,
					transport: ds.config.transport.mode,
					port: ds.config.transport.mode !== "stdio" ? ds.config.transport.port : undefined,
				},
				"Server starting",
			);

			serverLog.info(
				{
					transport: ds.config.transport.mode,
					port: ds.config.transport.mode !== "stdio" ? ds.config.transport.port : undefined,
				},
				"Server ready",
			);
		},
	});
}

// src/index.ts
import { type BootstrapLogger, createMcpApplication, type TelemetryConfig } from "@devops-agent/shared";
import { API_REGIONS, KongApi } from "./api/kong-api.js";
import { type Config, loadConfiguration } from "./config/index.js";
import { createKonnectServer } from "./server.ts";
import { createTransport } from "./transport/index.ts";
import { getRuntimeInfo } from "./utils/env.js";
import { mcpLogger } from "./utils/mcp-logger.js";
import { initializeTracing } from "./utils/tracing.js";

interface KonnectDatasource {
	api: KongApi;
	config: Config;
}

const logger: BootstrapLogger = {
	info: (msg: string, meta?: Record<string, unknown>) => mcpLogger.info("server", msg, meta),
	error: (msg: string, meta?: Record<string, unknown>) => mcpLogger.error("server", msg, meta),
	warn: (msg: string, meta?: Record<string, unknown>) => mcpLogger.warning("server", msg, meta),
};

const telemetryConfig: TelemetryConfig = {
	enabled: process.env.TELEMETRY_MODE !== undefined,
	serviceName: process.env.OTEL_SERVICE_NAME || "konnect-mcp-server",
	mode: (process.env.TELEMETRY_MODE as "console" | "otlp" | "both") || "console",
	otlpEndpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT || "http://localhost:4318",
};

const isMainModule = process.argv[1] && import.meta.url.includes(process.argv[1]);

if (isMainModule) {
	createMcpApplication<KonnectDatasource>({
		name: "konnect-mcp-server",
		logger,

		initTracing: () => initializeTracing(),
		telemetry: telemetryConfig,

		initDatasource: async () => {
			mcpLogger.info("config", "Loading configuration");
			const config = await loadConfiguration();

			mcpLogger.setMinLevelFromConfig(config.application.logLevel);

			const runtimeInfo = getRuntimeInfo();
			mcpLogger.info("runtime", "Runtime information", {
				runtime: runtimeInfo.runtime,
				version: runtimeInfo.version,
				envSource: runtimeInfo.envSource,
			});

			const api = new KongApi({
				apiKey: config.kong.accessToken,
				apiRegion: config.kong.region,
			});

			return { api, config };
		},

		createServerFactory: (ds) => () => createKonnectServer(ds.api, ds.config),

		createTransport: (serverFactory, ds) => createTransport(ds.config, serverFactory),

		onStarted: (ds) => {
			mcpLogger.startup("server", {
				availableRegions: Object.values(API_REGIONS),
				region: ds.config.kong.region,
				environment: ds.config.application.environment,
				logLevel: ds.config.application.logLevel,
				tracing: ds.config.tracing.enabled,
				monitoring: ds.config.monitoring.enabled,
				transport: ds.config.transport.mode,
				port: ds.config.transport.mode !== "stdio" ? ds.config.transport.port : undefined,
			});

			mcpLogger.ready("server", {
				transport: ds.config.transport.mode,
				port: ds.config.transport.mode !== "stdio" ? ds.config.transport.port : undefined,
			});
		},
	});
}

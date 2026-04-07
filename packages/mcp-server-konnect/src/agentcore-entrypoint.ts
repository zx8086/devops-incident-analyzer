// src/agentcore-entrypoint.ts
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
			serverLog.info("Loading configuration for AgentCore Runtime mode");
			const config = await loadConfiguration();

			logger.level = config.application.logLevel;

			const runtimeInfo = getRuntimeInfo();
			serverLog.info(
				{
					runtime: runtimeInfo.runtime,
					version: runtimeInfo.version,
					envSource: runtimeInfo.envSource,
					transport: "agentcore",
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

		createTransport: (serverFactory, ds) => {
			const agentCoreTransport = {
				...ds.config.transport,
				mode: "agentcore" as const,
				port: Number(Bun.env.MCP_PORT) || 8000,
				host: Bun.env.MCP_HOST || "0.0.0.0",
			};
			return createTransport(agentCoreTransport, serverFactory);
		},

		onStarted: (ds) => {
			serverLog.info(
				{
					region: ds.config.kong.region,
					environment: ds.config.application.environment,
					transport: "agentcore",
					port: Number(Bun.env.MCP_PORT) || 8000,
				},
				"Konnect MCP Server started on AgentCore Runtime",
			);
		},
	});
}

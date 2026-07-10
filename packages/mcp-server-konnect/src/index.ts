// src/index.ts
import {
	buildTelemetryConfig,
	canonicalizeUpstream,
	createBootstrapAdapter,
	createMcpApplication,
	createReadinessProbe,
} from "@devops-agent/shared";
import pkg from "../package.json" with { type: "json" };
import { KongApi } from "./api/kong-api.js";
import { type Config, loadConfiguration } from "./config/index.js";
import { createMcpServerFactory } from "./server.ts";
import { ElicitationOperations } from "./tools/elicitation-tool.js";
import { createTransport } from "./transport/index.ts";
import { getRuntimeInfo } from "./utils/env.js";
import { createContextLogger, logger } from "./utils/logger.js";
import { ToolPerformanceCollector } from "./utils/tool-tracer.js";
import { initializeTracing } from "./utils/tracing.js";

const serverLog = createContextLogger("server");

interface KonnectDatasource {
	api: KongApi;
	config: Config;
	// SIO-1044: hoisted out of createKonnectServer -- boot-once under the cached factory means these
	// closures over per-request `new` instances would otherwise freeze at the first request. Made
	// explicitly process-global here instead. Cheap/bounded: see server.ts hoist comment.
	performanceCollector: ToolPerformanceCollector;
	elicitationOps: ElicitationOperations;
}

if (import.meta.main) {
	createMcpApplication<KonnectDatasource>({
		name: "konnect-mcp-server",
		logger: createBootstrapAdapter(logger),

		initTracing: () => initializeTracing(),
		telemetry: buildTelemetryConfig("konnect-mcp-server"),

		role: "konnect-mcp",
		version: pkg.version,
		identityFingerprint: (ds) => canonicalizeUpstream({ region: ds.config.kong.region }),

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

			return {
				api,
				config,
				performanceCollector: new ToolPerformanceCollector(),
				elicitationOps: new ElicitationOperations(),
			};
		},

		createServerFactory: (ds) => createMcpServerFactory(ds),

		// SIO-779: proxy mode is not used for this server; non-null assertion is safe
		createTransport: (serverFactory, ds, identityCard) => {
			const konnectProbe = createReadinessProbe({
				components: {
					konnectControlPlane: async () => {
						await ds.api.listControlPlanes(1);
					},
				},
			});
			// biome-ignore lint/style/noNonNullAssertion: SIO-779 - server mode always provides createServerFactory
			return createTransport(ds.config.transport, serverFactory!, konnectProbe, identityCard);
		},

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

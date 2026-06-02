// src/index.ts
import {
	buildTelemetryConfig,
	canonicalizeUpstream,
	createBootstrapAdapter,
	createMcpApplication,
	createReadinessProbe,
} from "@devops-agent/shared";
import pkg from "../package.json" with { type: "json" };
import { type Config, loadConfig } from "./config.ts";
import { logger } from "./logger.ts";
import { createServer } from "./server.ts";
import { createTransport } from "./transport.ts";

if (import.meta.main) {
	createMcpApplication<Config>({
		name: "elastic-iac-mcp-server",
		logger: createBootstrapAdapter(logger),

		initTracing: () => {},
		telemetry: buildTelemetryConfig("elastic-iac-mcp-server"),

		role: "elastic-iac-mcp",
		version: pkg.version,
		identityFingerprint: (config) => canonicalizeUpstream({ instanceUrl: config.repository.gitlabBaseUrl }),

		initDatasource: async () => {
			const config = loadConfig();
			logger.info(
				{
					port: config.transport.port,
					projectId: config.repository.projectId,
					workspace: config.repository.workspaceDir,
				},
				"Starting Elastic IaC MCP Server",
			);
			return config;
		},

		createServerFactory: (config) => () => createServer(config),

		createTransport: (serverFactory, config, identityCard) => {
			const readinessProbe = createReadinessProbe({
				components: {
					// The server is stateless; readiness just confirms the process is serving.
					server: async () => {},
				},
			});
			// biome-ignore lint/style/noNonNullAssertion: server mode always provides createServerFactory
			return createTransport(serverFactory!, config, { readinessProbe, identityCard });
		},

		onStarted: (config) => {
			logger.info({ transport: config.transport.mode, port: config.transport.port }, "Elastic IaC MCP Server ready");
		},
	});
}

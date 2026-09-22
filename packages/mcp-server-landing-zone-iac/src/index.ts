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
import { createMcpServerFactory } from "./server.ts";
import { createTransport } from "./transport.ts";

if (import.meta.main) {
	createMcpApplication<Config>({
		name: "landing-zone-iac-mcp-server",
		logger: createBootstrapAdapter(logger),
		initTracing: () => {},
		telemetry: buildTelemetryConfig("landing-zone-iac-mcp-server"),
		role: "landing-zone-iac-mcp",
		version: pkg.version,
		identityFingerprint: (config) => canonicalizeUpstream({ instanceUrl: config.gitlab.baseUrl }),
		initDatasource: async () => {
			const config = loadConfig();
			logger.info(
				{ port: config.transport.port, gitlabBaseUrl: config.gitlab.baseUrl },
				"Starting Landing Zone IaC MCP Server",
			);
			return config;
		},
		createServerFactory: (config) => createMcpServerFactory(config),
		createTransport: (serverFactory, config, identityCard) => {
			const readinessProbe = createReadinessProbe({ components: { server: async () => {} } });
			// biome-ignore lint/style/noNonNullAssertion: server mode always provides createServerFactory
			return createTransport(serverFactory!, config, { readinessProbe, identityCard });
		},
		onStarted: (config) => {
			logger.info(
				{ transport: config.transport.mode, port: config.transport.port },
				"Landing Zone IaC MCP Server ready",
			);
		},
	});
}

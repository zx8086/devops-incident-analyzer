// src/index.ts
import { buildTelemetryConfig, createBootstrapAdapter, createMcpApplication } from "@devops-agent/shared";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import pkg from "../package.json" with { type: "json" };
import { type Config, loadConfig } from "./config/index.ts";
import { initializeTracing } from "./telemetry/tracing.ts";
import { registerAllTools } from "./tools/register.ts";
import { setDefaultCapBytes } from "./tools/wrap.ts";
import { createTransport } from "./transport/index.ts";
import { getRuntimeInfo } from "./utils/env.ts";
import { logger } from "./utils/logger.ts";

interface AwsDatasource {
	config: Config;
}

if (import.meta.main) {
	createMcpApplication<AwsDatasource>({
		name: "aws-mcp-server",
		logger: createBootstrapAdapter(logger),

		initTracing: () => initializeTracing(),
		telemetry: buildTelemetryConfig("aws-mcp-server"),

		initDatasource: async () => {
			const config = loadConfig();
			logger.level = config.logLevel;
			setDefaultCapBytes(config.toolResultCapBytes);

			const runtimeInfo = getRuntimeInfo();
			logger.info(
				{
					runtime: runtimeInfo.runtime,
					version: runtimeInfo.version,
					region: config.aws.region,
					transport: config.transport.mode,
					assumedRole: config.aws.assumedRoleArn,
				},
				"Starting AWS MCP Server",
			);

			return { config };
		},

		createServerFactory: (ds) => () => {
			const server = new McpServer({ name: "aws-mcp-server", version: pkg.version });
			registerAllTools(server, ds.config.aws);
			return server;
		},

		createTransport: (serverFactory, ds) => createTransport(ds.config.transport, serverFactory),

		onStarted: (ds) => {
			logger.info(
				{
					region: ds.config.aws.region,
					transport: ds.config.transport.mode,
					port: ds.config.transport.mode !== "stdio" ? ds.config.transport.port : undefined,
				},
				"AWS MCP server ready",
			);
		},
	});
}

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
	// Proxy-only mode: when an AgentCore runtime ARN is set, the AWS MCP server
	// runs remotely on AWS. Start only the local SigV4 proxy so the agent can
	// reach it. AWS_AGENTCORE_RUNTIME_ARN takes precedence over the generic
	// AGENTCORE_RUNTIME_ARN to support running both Kafka and AWS proxies
	// side-by-side without env-var collision.
	const runtimeArn = process.env.AWS_AGENTCORE_RUNTIME_ARN ?? process.env.AGENTCORE_RUNTIME_ARN;

	if (runtimeArn) {
		process.env.AGENTCORE_RUNTIME_ARN = runtimeArn;
		// startAgentCoreProxy reads AGENTCORE_PROXY_PORT; set default :3001 here
		// so the Kafka proxy on :3000 and the AWS proxy on :3001 don't collide.
		process.env.AGENTCORE_PROXY_PORT = process.env.AGENTCORE_PROXY_PORT ?? "3001";

		const { startAgentCoreProxy } = await import("@devops-agent/shared");
		logger.info({ arn: runtimeArn, transport: "agentcore-proxy" }, "Starting AWS MCP Server");
		const proxy = await startAgentCoreProxy();
		logger.info({ transport: "agentcore-proxy", port: proxy.port, url: proxy.url }, "AWS MCP Server ready");
		logger.info("aws-mcp-server started successfully");

		let isShuttingDown = false;
		const shutdown = async () => {
			if (isShuttingDown) return;
			isShuttingDown = true;
			logger.info("Shutting down aws-mcp-server...");
			await proxy.close();
			logger.info("aws-mcp-server shutdown completed");
			process.exit(0);
		};
		process.on("SIGINT", () => shutdown());
		process.on("SIGTERM", () => shutdown());
	} else {
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
}

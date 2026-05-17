// src/index.ts
import { GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";
import {
	buildTelemetryConfig,
	canonicalizeUpstream,
	createBootstrapAdapter,
	createMcpApplication,
	createReadinessProbe,
} from "@devops-agent/shared";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import pkg from "../package.json" with { type: "json" };
import { type Config, loadConfig } from "./config/index.ts";
import { buildAssumedCredsProvider } from "./services/credentials.ts";
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
	if (process.env.AWS_AGENTCORE_RUNTIME_ARN) {
		const { createAgentCoreProxyTransport, loadProxyConfigFromEnv } = await import("@devops-agent/shared");
		type AwsProxyDatasource = { config: ReturnType<typeof loadProxyConfigFromEnv> };

		createMcpApplication<AwsProxyDatasource>({
			name: "aws-mcp-server",
			logger: createBootstrapAdapter(logger),
			initTracing: () => initializeTracing(),
			telemetry: buildTelemetryConfig("aws-mcp-server"),
			mode: "proxy",
			role: "aws-proxy",
			version: pkg.version,
			identityFingerprint: (ds) => canonicalizeUpstream({ runtimeArn: ds.config.runtimeArn, region: ds.config.region }),
			initDatasource: async () => {
				const config = loadProxyConfigFromEnv("AWS");
				logger.info({ arn: config.runtimeArn, transport: "agentcore-proxy" }, "Starting AWS MCP Server");
				return { config };
			},
			createTransport: async (_factory, _ds, identityCard) =>
				createAgentCoreProxyTransport("AWS", createBootstrapAdapter(logger), identityCard),
			onStarted: (ds) => {
				logger.info({ arn: ds.config.runtimeArn, transport: "agentcore-proxy" }, "AWS MCP server ready");
			},
		});
	} else {
		createMcpApplication<AwsDatasource>({
			name: "aws-mcp-server",
			logger: createBootstrapAdapter(logger),

			initTracing: () => initializeTracing(),
			telemetry: buildTelemetryConfig("aws-mcp-server"),

			role: "aws-mcp",
			version: pkg.version,
			identityFingerprint: (ds) =>
				canonicalizeUpstream({ region: ds.config.aws.region, externalId: ds.config.aws.externalId }),

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

			// SIO-779: proxy mode is not used for this server; non-null assertion is safe
			createTransport: (serverFactory, ds, identityCard) => {
				// SIO-780: STS GetCallerIdentity probe validates the assumed-role
				// credential chain that every tool client uses. maxAttempts: 1 keeps
				// the call inside the 5s default withTimeout window during AWS hiccups.
				const stsClient = new STSClient({
					region: ds.config.aws.region,
					credentials: buildAssumedCredsProvider(ds.config.aws),
					maxAttempts: 1,
				});
				const awsProbe = createReadinessProbe({
					components: {
						sts: async () => {
							await stsClient.send(new GetCallerIdentityCommand({}));
						},
					},
				});
				// biome-ignore lint/style/noNonNullAssertion: SIO-779 - server mode always provides createServerFactory
				return createTransport(ds.config.transport, serverFactory!, awsProbe, identityCard);
			},

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

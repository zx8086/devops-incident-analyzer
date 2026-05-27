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
import { validateEstates } from "./services/estate-validator.ts";
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
				canonicalizeUpstream({
					region: ds.config.aws.region,
					estates: Object.keys(ds.config.aws.estates).sort().join(","),
				}),

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
						estates: Object.keys(config.aws.estates),
					},
					"Starting AWS MCP Server",
				);

				// SIO-828: validate each estate's AssumeRole chain before serving any
				// requests. Fail-closed on any failure -- a partially-working runtime
				// (prod-OK, dev-FAILED) would make the agent fan-out silently skip
				// dev with "no results" errors that take hours to diagnose.
				// Escape hatch SKIP_ESTATE_VALIDATION is honored ONLY when the
				// transport mode isn't agentcore (where boot-time validation is
				// non-negotiable).
				if (config.skipEstateValidation && config.transport.mode !== "agentcore") {
					logger.warn(
						{ transport: config.transport.mode },
						"SKIP_ESTATE_VALIDATION=true -- skipping boot-time estate validation (dev only)",
					);
				} else {
					const results = await validateEstates(config.aws);
					const failed = results.filter((r) => !r.ok);
					for (const r of results) {
						if (r.ok) {
							logger.info(
								{ estate: r.estate, assumedArn: r.assumedArn, durationMs: r.durationMs },
								"Estate validation OK",
							);
						} else {
							logger.error({ estate: r.estate, error: r.error, durationMs: r.durationMs }, "Estate validation FAILED");
						}
					}
					if (failed.length > 0) {
						const summary = failed.map((r) => `  - ${r.estate}: ${r.error}`).join("\n");
						throw new Error(
							`Refusing to start: ${failed.length}/${results.length} estate(s) failed STS:AssumeRole check.\n${summary}\n` +
								"Check that each estate's DevOpsAgentReadOnly trust policy lists the runtime's execution role as a Principal.",
						);
					}
					logger.info(
						{
							estateCount: results.length,
							slowestMs: Math.max(...results.map((r) => r.durationMs)),
						},
						"All estates validated",
					);
				}

				return { config };
			},

			createServerFactory: (ds) => () => {
				const server = new McpServer({ name: "aws-mcp-server", version: pkg.version });
				registerAllTools(server, ds.config.aws);
				return server;
			},

			// SIO-779: proxy mode is not used for this server; non-null assertion is safe
			createTransport: (serverFactory, ds, identityCard) => {
				// SIO-780 + SIO-828: STS GetCallerIdentity probe validates the
				// assumed-role chain. With multiple estates configured, we probe each
				// in turn so any misconfigured estate surfaces in the readiness
				// component the same way a single-estate failure used to.
				// maxAttempts: 1 keeps each call inside the 5s default withTimeout
				// window. The boot-time estate validator (estate-validator.ts) runs
				// before this and would already have refused start on any failure;
				// this probe is the runtime/transport-level signal for liveness.
				const estateProbes: Record<string, () => Promise<void>> = {};
				for (const [estateId, estateConfig] of Object.entries(ds.config.aws.estates)) {
					const stsClient = new STSClient({
						region: ds.config.aws.region,
						credentials: buildAssumedCredsProvider(estateConfig, ds.config.aws.region),
						maxAttempts: 1,
					});
					estateProbes[`sts:${estateId}`] = async () => {
						await stsClient.send(new GetCallerIdentityCommand({}));
					};
				}
				const awsProbe = createReadinessProbe({ components: estateProbes });
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

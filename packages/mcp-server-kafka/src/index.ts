// src/index.ts

import {
	buildTelemetryConfig,
	canonicalizeUpstream,
	createBootstrapAdapter,
	createCachedServerFactory,
	createMcpApplication,
	createReadinessProbe,
} from "@devops-agent/shared";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import pkg from "../package.json" with { type: "json" };
import { getConfig } from "./config/index.ts";
import type { AppConfig } from "./config/schemas.ts";
import { createProvider } from "./providers/factory.ts";
import { KafkaClientManager } from "./services/client-manager.ts";
import { ConnectService } from "./services/connect-service.ts";
import { KafkaService } from "./services/kafka-service.ts";
import { KsqlService } from "./services/ksql-service.ts";
import { RestProxyService } from "./services/restproxy-service.ts";
import { SchemaRegistryService } from "./services/schema-registry-service.ts";
import { computeRegisteredToolCount, registerAllTools, type ToolRegistrationOptions } from "./tools/index.ts";
import { createTransport } from "./transport/factory.ts";
import { logger } from "./utils/logger.ts";
import { initializeTracing } from "./utils/tracing.ts";

async function probeOptionalServices(opts: ToolRegistrationOptions, config: AppConfig): Promise<void> {
	const probes: Array<{ name: string; url: string; promise: Promise<void> }> = [];

	if (opts.schemaRegistryService) {
		probes.push({
			name: "schema-registry",
			url: config.schemaRegistry.url,
			promise: opts.schemaRegistryService.probeReachability(),
		});
	}
	if (opts.ksqlService) {
		probes.push({
			name: "ksqldb",
			url: config.ksql.endpoint,
			promise: opts.ksqlService.probeReachability(),
		});
	}
	if (opts.connectService) {
		probes.push({
			name: "kafka-connect",
			url: config.connect.url,
			promise: opts.connectService.probeReachability(),
		});
	}
	if (opts.restProxyService) {
		probes.push({
			name: "rest-proxy",
			url: config.restproxy.url,
			promise: opts.restProxyService.probeReachability(),
		});
	}

	const results = await Promise.allSettled(probes.map((p) => p.promise));
	for (const [i, result] of results.entries()) {
		const probe = probes[i];
		if (!probe) continue;
		const { name, url } = probe;
		if (result.status === "fulfilled") {
			logger.info({ component: name, url }, `${name} reachable`);
		} else {
			const reason = result.reason instanceof Error ? result.reason.message : String(result.reason);
			logger.warn(
				{ component: name, url, error: reason },
				`${name} unreachable - tools registered but calls will fail`,
			);
		}
	}
}

interface KafkaDatasource {
	kafkaService: KafkaService;
	clientManager: KafkaClientManager;
	toolOptions: ToolRegistrationOptions;
}

if (import.meta.main) {
	if (process.env.KAFKA_AGENTCORE_RUNTIME_ARN) {
		const { createAgentCoreProxyTransport, loadProxyConfigFromEnv } = await import("@devops-agent/shared");
		type KafkaProxyDatasource = { config: ReturnType<typeof loadProxyConfigFromEnv> };

		createMcpApplication<KafkaProxyDatasource>({
			name: "kafka-mcp-server",
			logger: createBootstrapAdapter(logger),
			initTracing: () => initializeTracing(),
			telemetry: buildTelemetryConfig("kafka-mcp-server"),
			mode: "proxy",
			role: "kafka-proxy",
			version: pkg.version,
			identityFingerprint: (ds) => canonicalizeUpstream({ runtimeArn: ds.config.runtimeArn, region: ds.config.region }),
			initDatasource: async () => {
				const config = loadProxyConfigFromEnv("KAFKA");
				logger.info({ arn: config.runtimeArn, transport: "agentcore-proxy" }, "Starting Kafka MCP Server");
				return { config };
			},
			createTransport: async (_factory, _ds, identityCard) =>
				createAgentCoreProxyTransport("KAFKA", createBootstrapAdapter(logger), identityCard),
			onStarted: (ds) => {
				logger.info({ arn: ds.config.runtimeArn, transport: "agentcore-proxy" }, "Kafka MCP server ready");
			},
		});
	} else {
		// Local mode: start the Kafka MCP server locally.
		const config = getConfig();
		logger.level = config.logging.level;

		createMcpApplication<KafkaDatasource>({
			name: "kafka-mcp-server",
			logger: createBootstrapAdapter(logger),

			initTracing: () => initializeTracing(),
			telemetry: buildTelemetryConfig("kafka-mcp-server"),

			role: "kafka-mcp",
			version: pkg.version,
			identityFingerprint: () =>
				canonicalizeUpstream({
					provider: config.kafka.provider,
					clientId: config.kafka.clientId,
					schemaRegistryEnabled: config.schemaRegistry.enabled,
					ksqlEnabled: config.ksql.enabled,
					connectEnabled: config.connect.enabled,
					restproxyEnabled: config.restproxy.enabled,
				}),

			initDatasource: async () => {
				logger.info(
					{
						provider: config.kafka.provider,
						clientId: config.kafka.clientId,
						transport: config.transport.mode,
					},
					"Starting Kafka MCP Server",
				);

				const provider = createProvider(config);
				logger.info(`Provider created: ${provider.name}`);

				const clientManager = new KafkaClientManager(provider, config.kafka.toolTimeoutMs);
				const kafkaService = new KafkaService(clientManager);
				const toolOptions: ToolRegistrationOptions = {};

				if (config.schemaRegistry.enabled) {
					toolOptions.schemaRegistryService = new SchemaRegistryService(config);
					logger.info({ url: config.schemaRegistry.url }, "Schema Registry enabled");
				}

				if (config.ksql.enabled) {
					toolOptions.ksqlService = new KsqlService(config);
					logger.info({ endpoint: config.ksql.endpoint }, "ksqlDB enabled");
				}

				if (config.connect.enabled) {
					toolOptions.connectService = new ConnectService(config);
					logger.info({ url: config.connect.url }, "Kafka Connect enabled");
				}

				if (config.restproxy.enabled) {
					toolOptions.restProxyService = new RestProxyService(config);
					logger.info({ url: config.restproxy.url }, "REST Proxy enabled");
				}

				await probeOptionalServices(toolOptions, config);

				return { kafkaService, clientManager, toolOptions };
			},

			// SIO-1044: record-once/replay-many -- registerAllTools' schema/closure construction
			// runs once at boot instead of once per stateless request.
			createServerFactory: (ds) =>
				createCachedServerFactory({
					createBareServer: () => new McpServer({ name: pkg.name, version: pkg.version }),
					registerAll: (server) => registerAllTools(server, ds.kafkaService, config, ds.toolOptions),
				}),

			// SIO-726: build the /ready probe from the same services tools were
			// registered with, then thread it into the HTTP transport. Stdio and
			// AgentCore transport modes ignore it -- AgentCore's framework health
			// surface is authoritative there.
			// SIO-779: proxy mode is not used for this server; non-null assertion is safe
			createTransport: (serverFactory, ds, identityCard) => {
				// SIO-780: capture optional services into locals so the closures the
				// shared probe receives don't trip biome's noNonNullAssertion rule.
				const { schemaRegistryService, ksqlService, connectService, restProxyService } = ds.toolOptions;
				return createTransport(
					config.transport,
					// biome-ignore lint/style/noNonNullAssertion: SIO-779 - server mode always provides createServerFactory
					serverFactory!,
					createReadinessProbe({
						components: {
							kafka: () =>
								ds.clientManager.withAdmin(async (admin) => {
									await admin.metadata({});
								}),
							schemaRegistry: schemaRegistryService ? () => schemaRegistryService.probeReachability() : null,
							ksql: ksqlService ? () => ksqlService.probeReachability() : null,
							connect: connectService ? () => connectService.probeReachability() : null,
							restproxy: restProxyService ? () => restProxyService.probeReachability() : null,
						},
					}),
					identityCard,
				);
			},

			cleanupDatasource: async (ds) => {
				await ds.clientManager.close();
				logger.info("Kafka clients closed");
			},

			onStarted: () => {
				// SIO-1193: single source of truth for the count -- the previous inline
				// copy drifted from registration (coreReads 10, SIO-742 health tools
				// omitted) and under-reported vs tools/list.
				const toolCount = computeRegisteredToolCount(config, {
					schemaRegistry: config.schemaRegistry.enabled,
					ksql: config.ksql.enabled,
					connect: config.connect.enabled,
					restProxy: config.restproxy.enabled,
				});
				logger.info(
					{
						provider: config.kafka.provider,
						transport: config.transport.mode,
						toolCount,
					},
					"Kafka MCP Server ready",
				);
			},
		});
	}
}

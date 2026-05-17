// src/index.ts

import { buildTelemetryConfig, createBootstrapAdapter, createMcpApplication } from "@devops-agent/shared";
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
import { registerAllTools, type ToolRegistrationOptions } from "./tools/index.ts";
import { createTransport } from "./transport/factory.ts";
import { createReadinessProbe } from "./transport/readiness.ts";
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
			logger.error(
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
		const { loadProxyConfigFromEnv, startAgentCoreProxy } = await import("@devops-agent/shared");
		const config = loadProxyConfigFromEnv("KAFKA");

		logger.info({ arn: config.runtimeArn, transport: "agentcore-proxy" }, "Starting Kafka MCP Server");
		const proxy = await startAgentCoreProxy(config);
		logger.info({ transport: "agentcore-proxy", port: proxy.port, url: proxy.url }, "Kafka MCP Server ready");
		logger.info("kafka-mcp-server started successfully");

		let isShuttingDown = false;
		const shutdown = async () => {
			if (isShuttingDown) return;
			isShuttingDown = true;
			logger.info("Shutting down kafka-mcp-server...");
			await proxy.close();
			logger.info("kafka-mcp-server shutdown completed");
			process.exit(0);
		};
		process.on("SIGINT", () => shutdown());
		process.on("SIGTERM", () => shutdown());
	} else {
		// Local mode: start the Kafka MCP server locally.
		const config = getConfig();
		logger.level = config.logging.level;

		createMcpApplication<KafkaDatasource>({
			name: "kafka-mcp-server",
			logger: createBootstrapAdapter(logger),

			initTracing: () => initializeTracing(),
			telemetry: buildTelemetryConfig("kafka-mcp-server"),

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

			createServerFactory: (ds) => () => {
				const server = new McpServer({ name: pkg.name, version: pkg.version });
				registerAllTools(server, ds.kafkaService, config, ds.toolOptions);
				return server;
			},

			// SIO-726: build the /ready probe from the same services tools were
			// registered with, then thread it into the HTTP transport. Stdio and
			// AgentCore transport modes ignore it -- AgentCore's framework health
			// surface is authoritative there.
			// SIO-779: proxy mode is not used for this server; non-null assertion is safe
			createTransport: (serverFactory, ds) =>
				createTransport(
					config.transport,
					// biome-ignore lint/style/noNonNullAssertion: SIO-779 - server mode always provides createServerFactory
					serverFactory!,
					createReadinessProbe({
						clientManager: ds.clientManager,
						toolOptions: ds.toolOptions,
						config,
					}),
				),

			cleanupDatasource: async (ds) => {
				await ds.clientManager.close();
				logger.info("Kafka clients closed");
			},

			onStarted: () => {
				// SIO-732: core writes/destructive and one ksql + 3 schema kafka_*
				// tools are gated at registration; reflect that in the reported count
				// so observability matches what's actually visible in tools/list.
				const coreReads = 10;
				const coreWrites = config.kafka.allowWrites ? 3 : 0;
				const coreDestructive = config.kafka.allowDestructive ? 2 : 0;
				const schemaReads = config.schemaRegistry.enabled ? 5 : 0;
				const schemaKafkaWrites = config.schemaRegistry.enabled && config.kafka.allowWrites ? 2 : 0;
				const schemaKafkaDestructive = config.schemaRegistry.enabled && config.kafka.allowDestructive ? 1 : 0;
				const ksqlReads = config.ksql.enabled ? 6 : 0;
				const ksqlWrites = config.ksql.enabled && config.kafka.allowWrites ? 1 : 0;
				const connectReads = config.connect.enabled ? 4 : 0;
				const connectWrites = config.connect.enabled && config.kafka.allowWrites ? 3 : 0;
				const connectDestructive = config.connect.enabled && config.kafka.allowDestructive ? 2 : 0;
				const srWrites = config.schemaRegistry.enabled && config.kafka.allowWrites ? 3 : 0;
				const srDestructive = config.schemaRegistry.enabled && config.kafka.allowDestructive ? 4 : 0;
				const restProxyReads = config.restproxy.enabled ? 3 : 0;
				const restProxyWrites = config.restproxy.enabled && config.kafka.allowWrites ? 6 : 0;
				const toolCount =
					coreReads +
					coreWrites +
					coreDestructive +
					schemaReads +
					schemaKafkaWrites +
					schemaKafkaDestructive +
					ksqlReads +
					ksqlWrites +
					connectReads +
					connectWrites +
					connectDestructive +
					srWrites +
					srDestructive +
					restProxyReads +
					restProxyWrites;
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

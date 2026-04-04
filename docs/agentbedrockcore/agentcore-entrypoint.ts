// src/agentcore-entrypoint.ts
//
// AgentCore Runtime entrypoint for the Kafka MCP server.
//
// This is an alternative entrypoint to index.ts, used when deploying
// to AWS Bedrock AgentCore Runtime. It:
//
// 1. Forces the transport to AgentCore mode (port 8000, stateless, /mcp path)
// 2. Skips stdio transport (not used in AgentCore)
// 3. Reuses all existing service initialization (provider, clients, tools)
// 4. Adds the /ping health endpoint required by AgentCore
//
// Usage:
//   Local test:  bun run src/agentcore-entrypoint.ts
//   Container:   CMD ["bun", "run", "src/agentcore-entrypoint.ts"]
//
// The existing index.ts entrypoint remains for local dev, Claude Desktop,
// and non-AgentCore deployments (ECS, EKS, etc).

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getConfig } from "./config/index.ts";
import { getLogger } from "./logging/container.ts";
import { createProvider } from "./providers/factory.ts";
import { KafkaClientManager } from "./services/client-manager.ts";
import { KafkaService } from "./services/kafka-service.ts";
import { KsqlService } from "./services/ksql-service.ts";
import { SchemaRegistryService } from "./services/schema-registry-service.ts";
import { initializeTracing } from "./telemetry/tracing.ts";
import { registerAllTools, type ToolRegistrationOptions } from "./tools/index.ts";
import { startAgentCoreTransport } from "./transport/agentcore.ts";

if (import.meta.main) {
	const config = getConfig();
	const logger = getLogger();
	logger.level = config.logging.level;

	// Initialize telemetry if enabled
	if (config.telemetry.enabled) {
		initializeTracing();
	}

	logger.info(
		{
			provider: config.kafka.provider,
			clientId: config.kafka.clientId,
			mode: "agentcore",
		},
		"Starting Kafka MCP Server (AgentCore Runtime mode)",
	);

	// ── Initialize Kafka provider and services ──
	const provider = createProvider(config);
	logger.info(`Provider created: ${provider.name}`);

	const clientManager = new KafkaClientManager(provider);
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

	// ── Server factory — creates a fresh McpServer per request (stateless) ──
	const serverFactory = () => {
		const server = new McpServer({ name: "kafka-mcp-server", version: "1.0.0" });
		registerAllTools(server, kafkaService, config, toolOptions);
		return server;
	};

	// ── Start AgentCore transport ──
	// Port defaults to 8000, path to /mcp — matching AgentCore's expectations
	const transport = await startAgentCoreTransport(serverFactory, {
		port: Number(Bun.env.MCP_PORT) || 8000,
		host: Bun.env.MCP_HOST || "0.0.0.0",
		path: Bun.env.MCP_PATH || "/mcp",
	});

	const toolCount = 15 + (config.schemaRegistry.enabled ? 8 : 0) + (config.ksql.enabled ? 7 : 0);
	logger.info(
		{
			provider: config.kafka.provider,
			tools: toolCount,
			mode: "agentcore",
			url: `http://0.0.0.0:${Number(Bun.env.MCP_PORT) || 8000}/mcp`,
		},
		`Kafka MCP Server ready on AgentCore Runtime (${toolCount} tools)`,
	);

	// ── Graceful shutdown ──
	const shutdown = async () => {
		logger.info("Shutting down Kafka MCP Server (AgentCore)");
		await transport.close();
		await clientManager.close();
		logger.info("Kafka clients closed");
		process.exit(0);
	};

	process.on("SIGTERM", shutdown);
	process.on("SIGINT", shutdown);
}

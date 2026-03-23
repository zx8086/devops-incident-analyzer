// src/index.ts

// Import global setup first
import "./set-global";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { config } from "./config";
import { connectionManager } from "./lib/connectionManager";
import { AppError } from "./lib/errors";
import { logger } from "./lib/logger";
import { registerPingHandlers } from "./lib/pingHandler";
import { registerResources } from "./lib/resourceHandlers";
import { registerResourceMethods } from "./lib/resources";
import { ToolRegistry } from "./lib/toolRegistry";
import { registerSqlppQueryGenerator } from "./prompts/sqlppQueryGenerator";
import { registerAllResources } from "./resources";
import { registerDatabaseStructureResource } from "./resources/databaseStructureResource";
import { initTelemetry, shutdownTelemetry, type TelemetryConfig } from "./telemetry/telemetry";
import { createTransport } from "./transport/index.ts";
import type { AppContext } from "./types";
import { initializeTracing } from "./utils/tracing";

// Application context setup
const appContext: AppContext = {
	readOnlyQueryMode: config.server.readOnlyQueryMode,
};

export function createServer(bucket: any): McpServer {
	const server = new McpServer({
		name: config.server.name,
		version: config.server.version,
		capabilities: {
			tools: {},
			resources: {},
			prompts: {},
		},
	});

	// Minimal hardcoded resource for debugging
	server.resource("test-playbook", "playbook://test.md", async (uri) => ({
		contents: [
			{
				uri: uri.href,
				mimeType: "text/markdown",
				text: "# Test",
			},
		],
	}));

	// Register all tools
	ToolRegistry.registerAll(server, bucket);

	// Register our SQL++ query generator prompt
	registerSqlppQueryGenerator(server);

	// Register all Couchbase resources
	registerAllResources(server, bucket);

	// Add a public method to read resources by URI
	(server as any).readResourceByUri = async function (resourceUri) {
		// Root cause explanation:
		// Some SDK versions store resources as a Map (iterable), others as a plain object (not iterable).
		// We must support both cases for compatibility.
		const resourceMap = (this as any)._resources || (this as any).resources || (this as any)._registeredResources;
		if (!resourceMap) {
			console.error("No resource registry found on server instance. Available keys:", Object.keys(this));
			throw new Error(
				"No resource registry found on server instance (tried _resources, resources, _registeredResources)",
			);
		}
		let resourcesIterable;
		if (resourceMap instanceof Map) {
			resourcesIterable = resourceMap.values();
		} else if (typeof resourceMap === "object") {
			resourcesIterable = Object.values(resourceMap);
		} else {
			throw new Error("Resource registry is not iterable");
		}
		for (const resource of resourcesIterable) {
			// Template match
			if (resource.template && resource.template.match) {
				const match = resource.template.match(resourceUri);
				if (match) {
					return await resource.handler({ href: resourceUri }, match);
				}
			}
			// Static URI match
			if (resource.uri && resource.uri === resourceUri) {
				return await resource.handler({ href: resourceUri }, {});
			}
		}
		throw new Error(`No resource handler found for URI: ${resourceUri}`);
	}.bind(server);

	// Register ping handlers for both protocol and tool usage
	registerPingHandlers(server);

	// Register a minimal echo tool for debugging
	function getDocLogger() {
		const { createContextLogger } = require("./lib/logger");
		return createContextLogger("EchoTool");
	}
	server.tool("echo", "Echoes back the input parameters for debugging", {}, async (params: any) => {
		getDocLogger().info("EchoTool RAW params", { raw_params: JSON.stringify(params) });
		return { content: [{ type: "text", text: JSON.stringify(params) }] };
	});

	return server;
}

// Exponential backoff with circuit breaker for Couchbase connection
async function connectWithBackoffAndCircuitBreaker(
	maxAttempts = 10,
	baseDelayMs = 1000,
	maxDelayMs = 30000,
	circuitBreakerThreshold = 5,
	circuitBreakerCooldownMs = 60000,
) {
	let failures = 0;
	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		try {
			await connectionManager.initialize();
			return;
		} catch (err) {
			failures++;
			logger.error(
				`Couchbase connection failed (attempt ${attempt}/${maxAttempts}): ${err instanceof Error ? err.message : String(err)}`,
			);
			if (failures >= circuitBreakerThreshold) {
				logger.error(`Circuit breaker tripped. Pausing for ${circuitBreakerCooldownMs / 1000}s`);
				await sleep(circuitBreakerCooldownMs);
				failures = 0;
			} else {
				const delay = Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs);
				await sleep(delay);
			}
		}
	}
	throw new Error("Failed to connect to Couchbase after multiple attempts");
}

async function main(): Promise<void> {
	try {
		initializeTracing();

		const telemetryConfig: TelemetryConfig = {
			enabled: process.env.TELEMETRY_MODE !== undefined,
			serviceName: process.env.OTEL_SERVICE_NAME || "couchbase-mcp-server",
			mode: (process.env.TELEMETRY_MODE as "console" | "otlp" | "both") || "console",
			otlpEndpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT || "http://localhost:4318",
		};
		const otelSdk = initTelemetry(telemetryConfig);

		logger.info("Starting Couchbase MCP Server...");

		// Initialize the connection manager with backoff and circuit breaker
		await connectWithBackoffAndCircuitBreaker();

		const bucket = await connectionManager.getConnection();
		const serverFactory = () => createServer(bucket);

		const transport = await createTransport(config.transport, serverFactory);

		// Graceful shutdown
		const shutdown = async () => {
			logger.info("Shutting down Couchbase MCP Server...");
			await transport.closeAll();
			await shutdownTelemetry(otelSdk);
			process.exit(0);
		};
		process.on("SIGINT", shutdown);
		process.on("SIGTERM", shutdown);

		logger.info("Couchbase MCP Server started successfully", {
			mode: config.transport.mode,
		});
	} catch (error) {
		logger.error(`Fatal error in main(): ${error instanceof Error ? error.message : String(error)}`);
		process.exit(1);
	}
}

// Handle uncaught errors
process.on("uncaughtException", (error) => {
	logger.error("Uncaught Exception:", { error: error.message, stack: error.stack });
	process.exit(1);
});

process.on("unhandledRejection", (reason) => {
	logger.error("Unhandled Rejection:", { reason: reason instanceof Error ? reason.message : String(reason) });
	process.exit(1);
});

// Start the server
main().catch((error) => {
	logger.error(`Fatal error in main(): ${error instanceof Error ? error.message : String(error)}`);
	process.exit(1);
});

export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

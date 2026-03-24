// src/index.ts

// Import global setup first
import "./set-global";

import { buildTelemetryConfig, createBootstrapAdapter, createMcpApplication } from "@devops-agent/shared";
import { config } from "./config";
import { connectionManager } from "./lib/connectionManager";
import { logger } from "./lib/logger";
import { createServer } from "./server.ts";
import { createTransport } from "./transport/index.ts";
import { initializeTracing } from "./utils/tracing";

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

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

createMcpApplication({
	name: "couchbase-mcp-server",
	logger: createBootstrapAdapter(logger),

	initTracing: () => initializeTracing(),
	telemetry: buildTelemetryConfig("couchbase-mcp-server"),

	initDatasource: async () => {
		logger.info("Starting Couchbase MCP Server...");
		await connectWithBackoffAndCircuitBreaker();
		return connectionManager.getConnection();
	},

	createServerFactory: (bucket) => () => createServer(bucket),

	createTransport: (serverFactory) => createTransport(config.transport, serverFactory),

	onStarted: () => {
		logger.info(
			{
				mode: config.transport.mode,
			},
			"Couchbase MCP Server started successfully",
		);
	},
});

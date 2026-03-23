#!/usr/bin/env bun

// src/server.ts
import { readFileSync } from "node:fs";
import { Client } from "@elastic/elasticsearch";
import { HttpConnection } from "@elastic/transport";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "./config.js";
import { registerAllTools } from "./tools/index.js";
import { logger } from "./utils/logger.js";
import { initializeReadOnlyManager } from "./utils/readOnlyMode.js";

// Async -- called once at startup. Initializes read-only manager, builds ES client, tests connection.
export async function initializeElasticsearchClient(config: Config): Promise<Client> {
	logger.info(
		{
			url: config.elasticsearch.url,
			hasApiKey: !!config.elasticsearch.apiKey,
			hasUsername: !!config.elasticsearch.username,
			hasPassword: !!config.elasticsearch.password,
			hasCaCert: !!config.elasticsearch.caCert,
			readOnlyMode: config.server.readOnlyMode,
			readOnlyStrictMode: config.server.readOnlyStrictMode,
			tracingEnabled: config.langsmith.tracing,
		},
		"Creating Elasticsearch MCP server",
	);

	// Initialize read-only mode manager with config values
	initializeReadOnlyManager(config.server.readOnlyMode, config.server.readOnlyStrictMode);

	if (config.server.readOnlyMode) {
		logger.info(
			{
				strictMode: config.server.readOnlyStrictMode,
				behavior: config.server.readOnlyStrictMode
					? "Destructive operations will be BLOCKED"
					: "Destructive operations will show WARNINGS",
			},
			"READ-ONLY MODE ACTIVE",
		);
	}

	// Build Elasticsearch client configuration
	const clientOptions: ConstructorParameters<typeof Client>[0] = {
		node: config.elasticsearch.url,
		auth: config.elasticsearch.apiKey
			? { apiKey: config.elasticsearch.apiKey }
			: config.elasticsearch.username && config.elasticsearch.password
				? { username: config.elasticsearch.username, password: config.elasticsearch.password }
				: undefined,

		Connection: HttpConnection,

		compression: config.elasticsearch.compression,
		maxRetries: config.elasticsearch.maxRetries,
		requestTimeout: config.elasticsearch.requestTimeout,

		name: config.server.name,
		opaqueIdPrefix: `${config.server.name}::`,

		headers: {
			Accept: "application/json",
			"Content-Type": "application/json",
			"Accept-Encoding": "gzip, deflate",
		},

		context: {
			userAgent: `${config.server.name}/${config.server.version} (bun)`,
		},

		redaction: {
			type: "replace",
			additionalKeys: ["authorization", "x-elastic-client-meta"],
		},

		enableMetaHeader: config.elasticsearch.enableMetaHeader,
		disablePrototypePoisoningProtection: config.elasticsearch.disablePrototypePoisoningProtection,

		...(config.elasticsearch.caCert && {
			tls: {
				ca: readFileSync(config.elasticsearch.caCert),
				rejectUnauthorized: true,
			},
		}),
	};

	logger.debug(
		{
			...clientOptions,
			auth: clientOptions.auth ? "[REDACTED]" : undefined,
			tls: clientOptions.tls ? "[TLS_CONFIG_PRESENT]" : undefined,
			Connection: "HttpConnection",
		},
		"Initializing Elasticsearch client with configuration:",
	);

	const esClient = new Client(clientOptions);

	// Register connection pool event listeners for observability
	try {
		const pool = esClient.connectionPool as unknown as Record<string, unknown>;
		if (pool && typeof (pool as { on?: unknown }).on === "function") {
			const emitter = pool as { on: (event: string, cb: (...args: unknown[]) => void) => void };
			emitter.on("connection:dead", (...args: unknown[]) => {
				const connection = args[0] as { url?: string; id?: string } | undefined;
				const error = args[1] as { message?: string } | undefined;
				logger.error(
					{
						url: connection?.url,
						id: connection?.id,
						error: error?.message,
					},
					"Elasticsearch connection marked as dead",
				);
			});

			emitter.on("connection:resurrect", (...args: unknown[]) => {
				const connection = args[0] as { url?: string; id?: string } | undefined;
				logger.info(
					{
						url: connection?.url,
						id: connection?.id,
					},
					"Elasticsearch connection resurrected",
				);
			});
		}
	} catch (error) {
		logger.warn(
			{
				error: error instanceof Error ? error.message : String(error),
			},
			"Could not register connection pool events",
		);
	}

	// Test connection to Elasticsearch
	try {
		const info = await esClient.info();

		logger.info(
			{
				version: info.version?.number,
				clusterName: info.cluster_name,
				clusterUuid: info.cluster_uuid,
				luceneVersion: info.version?.lucene_version,
			},
			"Successfully connected to Elasticsearch",
		);

		const serverVersion = info.version?.number;
		const majorVersion = serverVersion ? Number.parseInt(serverVersion.split(".")[0] ?? "0", 10) : 0;

		if (majorVersion >= 9) {
			logger.info(`Connected to Elasticsearch ${serverVersion} - using modern client features`);
		} else if (majorVersion >= 8) {
			logger.info(`Connected to Elasticsearch ${serverVersion} - full feature support`);
		} else {
			logger.warn(`Connected to older Elasticsearch ${serverVersion} - some features may be limited`);
		}
	} catch (error: unknown) {
		logger.error(
			{
				error: error instanceof Error ? error.message : String(error),
				stack: error instanceof Error ? error.stack : undefined,
			},
			"Failed to connect to Elasticsearch:",
		);
		throw error;
	}

	return esClient;
}

// Sync -- called per-request by factory. Creates McpServer and registers tools.
export function createMcpServerInstance(config: Config, esClient: Client): McpServer {
	const server = new McpServer(
		{
			name: config.server.name,
			version: config.server.version,
		},
		{
			capabilities: {
				notifications: {
					supportsProgress: true,
					supportsLogging: true,
				},
				tools: {
					listChanged: true,
				},
			} as Record<string, unknown>,
			instructions: `Elasticsearch MCP Server (${config.server.version}) - Comprehensive Elasticsearch operations with ${config.server.readOnlyMode ? "READ-ONLY" : "FULL-ACCESS"} mode`,
		},
	);

	const registeredTools = registerAllTools(server, esClient);

	logger.info(
		{
			toolCount: registeredTools.length,
		},
		"All tools registered successfully",
	);

	return server;
}

// Convenience function that calls both (kept for backward compatibility)
export async function createElasticsearchMcpServer(config: Config): Promise<McpServer> {
	try {
		const esClient = await initializeElasticsearchClient(config);
		return createMcpServerInstance(config, esClient);
	} catch (error: unknown) {
		logger.error(
			{
				error: error instanceof Error ? error.message : String(error),
				stack: error instanceof Error ? error.stack : undefined,
			},
			"Error creating server:",
		);
		throw error;
	}
}

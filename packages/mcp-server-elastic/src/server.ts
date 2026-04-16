#!/usr/bin/env bun

// src/server.ts
import { readFileSync } from "node:fs";
import { Client } from "@elastic/elasticsearch";
import { HttpConnection } from "@elastic/transport";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createClientProxy, registerClients } from "./clients/registry.js";
import type { Config, DeploymentConfig } from "./config/index.js";
import { registerAllTools } from "./tools/index.js";
import { logger } from "./utils/logger.js";
import { initializeReadOnlyManager } from "./utils/readOnlyMode.js";

interface DeploymentSpec {
	id: string;
	url: string;
	apiKey?: string;
	username?: string;
	password?: string;
	caCert?: string;
}

// SIO-649: Build a single ES client for one deployment, tests the connection. Shared helper so
// the multi-deployment and legacy single-deployment paths go through the same code.
async function buildDeploymentClient(spec: DeploymentSpec, config: Config): Promise<Client> {
	const clientOptions: ConstructorParameters<typeof Client>[0] = {
		node: spec.url,
		auth: spec.apiKey
			? { apiKey: spec.apiKey }
			: spec.username && spec.password
				? { username: spec.username, password: spec.password }
				: undefined,

		Connection: HttpConnection,

		compression: config.elasticsearch.compression,
		maxRetries: config.elasticsearch.maxRetries,
		requestTimeout: config.elasticsearch.requestTimeout,

		name: config.server.name,
		opaqueIdPrefix: `${config.server.name}::${spec.id}::`,

		headers: {
			Accept: "application/json",
			"Content-Type": "application/json",
			"Accept-Encoding": "gzip, deflate",
		},

		context: {
			userAgent: `${config.server.name}/${config.server.version} (bun)`,
			deploymentId: spec.id,
		},

		redaction: {
			type: "replace",
			additionalKeys: ["authorization", "x-elastic-client-meta"],
		},

		enableMetaHeader: config.elasticsearch.enableMetaHeader,
		disablePrototypePoisoningProtection: config.elasticsearch.disablePrototypePoisoningProtection,

		...(spec.caCert && {
			tls: {
				ca: readFileSync(spec.caCert),
				rejectUnauthorized: true,
			},
		}),
	};

	logger.debug(
		{
			deploymentId: spec.id,
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
						deploymentId: spec.id,
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
						deploymentId: spec.id,
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
				deploymentId: spec.id,
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
				deploymentId: spec.id,
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
			logger.info(`[${spec.id}] Connected to Elasticsearch ${serverVersion} - using modern client features`);
		} else if (majorVersion >= 8) {
			logger.info(`[${spec.id}] Connected to Elasticsearch ${serverVersion} - full feature support`);
		} else {
			logger.warn(`[${spec.id}] Connected to older Elasticsearch ${serverVersion} - some features may be limited`);
		}
	} catch (error: unknown) {
		logger.error(
			{
				deploymentId: spec.id,
				error: error instanceof Error ? error.message : String(error),
				stack: error instanceof Error ? error.stack : undefined,
			},
			"Failed to connect to Elasticsearch:",
		);
		throw error;
	}

	return esClient;
}

// SIO-649: Shared startup logging + read-only manager bootstrap for both client init paths.
function bootstrapReadOnly(config: Config): void {
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
			deploymentCount: config.elasticsearch.deployments?.length ?? 1,
		},
		"Creating Elasticsearch MCP server",
	);

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
}

// SIO-649: Initialize N clients (one per configured deployment) and register them so the
// request-scoped Proxy in clients/registry.ts can route calls. Returns the Proxy that gets
// passed into registerAllTools -- tools see one `Client` and don't know routing exists.
export async function initializeElasticsearchClient(config: Config): Promise<Client> {
	bootstrapReadOnly(config);

	const specs: DeploymentSpec[] = (config.elasticsearch.deployments as DeploymentConfig[] | undefined)?.length
		? (config.elasticsearch.deployments as DeploymentConfig[]).map((d) => ({
				id: d.id,
				url: d.url,
				apiKey: d.apiKey,
				username: d.username,
				password: d.password,
				caCert: d.caCert,
			}))
		: [
				{
					id: "default",
					url: config.elasticsearch.url,
					apiKey: config.elasticsearch.apiKey,
					username: config.elasticsearch.username,
					password: config.elasticsearch.password,
					caCert: config.elasticsearch.caCert,
				},
			];

	const defaultId = config.elasticsearch.defaultDeploymentId ?? specs[0]?.id ?? "default";

	logger.info(
		{ deploymentIds: specs.map((s) => s.id), defaultId },
		`Loaded ${specs.length} deployment${specs.length === 1 ? "" : "s"}`,
	);

	const clients = new Map<string, Client>();
	// Connect sequentially so a failing deployment surfaces a clear per-id error rather than a
	// Promise.all reject that masks which connection broke.
	for (const spec of specs) {
		const client = await buildDeploymentClient(spec, config);
		clients.set(spec.id, client);
	}

	registerClients(clients, defaultId);

	return createClientProxy();
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

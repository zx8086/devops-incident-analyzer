#!/usr/bin/env bun

// src/index.ts
import {
	buildTelemetryConfig,
	canonicalizeUpstream,
	createBootstrapAdapter,
	createMcpApplication,
	createReadinessProbe,
} from "@devops-agent/shared";
import pkg from "../package.json" with { type: "json" };
import { initializeCloudClient } from "./clients/cloudClient.js";
import { runWithDeployment } from "./clients/context.js";
import { listRegisteredDeploymentIds } from "./clients/registry.js";
import { clearConfigWarnings, config, getConfigWarnings } from "./config/index.js";
import { createMcpServerFactory, initializeElasticsearchClient } from "./server.js";
import { createTransport } from "./transport/index.js";
import { logger } from "./utils/logger.js";
import { getReadOnlyManager } from "./utils/readOnlyMode.js";
import { initializeTracing } from "./utils/tracing.js";

if (import.meta.main) {
	createMcpApplication({
		name: "elastic-mcp-server",
		logger: createBootstrapAdapter(logger),

		initTracing: () => initializeTracing(),
		telemetry: buildTelemetryConfig("elastic-mcp-server"),

		role: "elastic-mcp",
		version: pkg.version,
		identityFingerprint: () =>
			canonicalizeUpstream({
				deployments: (config.elasticsearch.deployments ?? []).map((d) => ({ id: d.id, url: d.url })),
			}),

		initDatasource: async () => {
			const configWarnings = getConfigWarnings();
			if (configWarnings.length > 0) {
				for (const warning of configWarnings) {
					logger.warn(warning);
				}
				clearConfigWarnings();
			}

			logger.info(
				{
					url: config.elasticsearch.url,
					hasApiKey: !!config.elasticsearch.apiKey,
					hasUsername: !!config.elasticsearch.username,
					hasPassword: !!config.elasticsearch.password,
					hasCaCert: !!config.elasticsearch.caCert,
					readOnlyMode: config.server.readOnlyMode,
					readOnlyStrictMode: config.server.readOnlyStrictMode,
					maxQueryTimeout: config.server.maxQueryTimeout,
					maxResultsPerQuery: config.server.maxResultsPerQuery,
					transport: config.server.transportMode,
					port: config.server.port,
				},
				"Starting Elasticsearch MCP Server",
			);

			return initializeElasticsearchClient(config);
		},

		// SIO-674: Build the Elastic Cloud client once per server (lazy auth -- no probe).
		// initializeCloudClient returns null when EC_API_KEY is unset; the factory then records
		// cluster tools only and the cloud + billing tools never appear.
		// SIO-1041: createMcpServerFactory records the ~96 wrapped tool registrations ONCE at boot
		// and replays them per request, instead of re-running registerAllTools on every request.
		createServerFactory: (esClient) => {
			const cloudClient = initializeCloudClient(config);
			return createMcpServerFactory(config, esClient, cloudClient);
		},

		// SIO-671: hoisted from per-tool withReadOnlyCheck wrappers. The shared
		// bootstrap installs a single dispatcher-level chokepoint per server.
		// The wrapper defers manager lookup to call time because the singleton
		// is initialized inside initDatasource (after this options literal is
		// evaluated).
		readOnly: {
			manager: {
				checkOperation: (toolName) => getReadOnlyManager().checkOperation(toolName),
				createBlockedResponse: (toolName) => getReadOnlyManager().createBlockedResponse(toolName),
				createWarningResponse: (toolName, originalResponse) =>
					getReadOnlyManager().createWarningResponse(toolName, originalResponse as never),
			},
		},

		// SIO-780: build a per-deployment readiness probe. One component per
		// registered deployment so a single-cluster outage in multi-deployment
		// setups is visible in the snapshot. runWithDeployment sets the AsyncLocalStorage
		// context the registry Proxy reads so esClient.cluster.health() routes to the
		// right cluster. Stdio/AgentCore modes ignore the probe (no /ready route).
		createTransport: (serverFactory, esClient, identityCard) => {
			const elasticProbe = createReadinessProbe({
				components: Object.fromEntries(
					listRegisteredDeploymentIds().map((id) => [
						`elastic-${id}`,
						() =>
							runWithDeployment(id, async () => {
								await esClient.cluster.health();
							}),
					]),
				),
			});
			return createTransport(
				{
					mode: config.server.transportMode,
					port: config.server.port,
					host: config.server.host ?? "0.0.0.0",
					path: config.server.path ?? "/mcp",
					sessionMode: (config.server.sessionMode ?? "stateless") as "stateless" | "stateful",
					idleTimeout: config.server.idleTimeout ?? 255,
					apiKey: config.server.apiKey,
					allowedOrigins: config.server.allowedOrigins,
				},
				// SIO-779: server mode always provides createServerFactory; non-null assertion is safe
				// biome-ignore lint/style/noNonNullAssertion: SIO-779 - server mode always provides createServerFactory
				serverFactory!,
				elasticProbe,
				identityCard,
			);
		},

		onStarted: () => {
			logger.info(
				{
					mode: config.server.readOnlyMode ? "READ-ONLY" : "FULL-ACCESS",
					strictMode: config.server.readOnlyStrictMode,
					transport: config.server.transportMode,
				},
				"Elasticsearch MCP Server ready",
			);
		},
	});
}

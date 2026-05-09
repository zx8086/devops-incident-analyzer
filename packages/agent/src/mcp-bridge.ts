// agent/src/mcp-bridge.ts

import { AsyncLocalStorage } from "node:async_hooks";
import { getLogger } from "@devops-agent/observability";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { context, propagation } from "@opentelemetry/api";

const logger = getLogger("mcp-bridge");

// SIO-649: Per-call deployment context. The elastic sub-agent's fan-out loop enters this
// context before invoking its tools, and beforeToolCall reads it to stamp the MCP request
// with X-Elastic-Deployment. One static beforeToolCall handles dynamic routing.
const deploymentStorage = new AsyncLocalStorage<{ deploymentId: string }>();

export function withElasticDeployment<T>(deploymentId: string, fn: () => Promise<T>): Promise<T> {
	return deploymentStorage.run({ deploymentId }, fn);
}

function currentElasticDeployment(): string | undefined {
	return deploymentStorage.getStore()?.deploymentId;
}

export interface McpClientConfig {
	elasticUrl?: string;
	kafkaUrl?: string;
	capellaUrl?: string;
	konnectUrl?: string;
	gitlabUrl?: string;
	atlassianUrl?: string;
}

// SIO-595: All MCP servers use Streamable HTTP transport at /mcp
let allTools: StructuredToolInterface[] = [];
let connectedServers: Set<string> = new Set();
let toolsByServer: Map<string, StructuredToolInterface[]> = new Map();

// SIO-608: Health polling state
let serverUrls: Map<string, string> = new Map();
let healthPollTimer: ReturnType<typeof setInterval> | null = null;
let isPolling = false;
const HEALTH_POLL_INTERVAL_MS = 30_000;
const MCP_CONNECT_TIMEOUT_MS = 10_000;

// SIO-680/682: Generic timeout wrapper. Races the input promise against
// AbortSignal.timeout(ms); rejects with a descriptive error if the promise
// hasn't settled by deadline.
//
// KNOWN LIMITATION: when the timeout fires, the underlying operation is NOT
// cancelled -- the in-flight HTTP request inside MultiServerMCPClient.getTools()
// keeps running until it resolves on its own (the SDK in @langchain/mcp-adapters
// v1.1.3 doesn't accept an AbortSignal parameter). The leaked promise is reclaimed
// when the agent process exits. In production the next health-poll cycle attempts
// a fresh connect via reconnectServer, so the leak is bounded by the poll interval.
//
// Re-exported as _withTimeoutForTest at the bottom of the file for unit testing.
async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
	const timeoutPromise = new Promise<never>((_, reject) => {
		const signal = AbortSignal.timeout(ms);
		signal.addEventListener("abort", () => {
			reject(new Error(`${label} timed out after ${ms}ms`));
		});
	});
	return Promise.race([promise, timeoutPromise]);
}

function injectTraceHeaders(): { headers: Record<string, string> } | undefined {
	const headers: Record<string, string> = {};
	propagation.inject(context.active(), headers);
	return Object.keys(headers).length > 0 ? { headers } : undefined;
}

// SIO-649: Elastic-specific hook that adds X-Elastic-Deployment alongside trace headers when
// the caller is inside a withElasticDeployment() scope. Non-elastic MCP clients keep using
// injectTraceHeaders and never see this header.
function injectElasticHeaders(): { headers: Record<string, string> } | undefined {
	const headers: Record<string, string> = {};
	propagation.inject(context.active(), headers);
	const deploymentId = currentElasticDeployment();
	if (deploymentId) headers["x-elastic-deployment"] = deploymentId;
	return Object.keys(headers).length > 0 ? { headers } : undefined;
}

export async function createMcpClient(config: McpClientConfig): Promise<void> {
	const { MultiServerMCPClient } = await import("@langchain/mcp-adapters");

	const serverEntries: Array<{ name: string; url: string }> = [];

	if (config.elasticUrl) {
		serverEntries.push({ name: "elastic-mcp", url: `${config.elasticUrl}/mcp` });
	}
	if (config.kafkaUrl) {
		serverEntries.push({ name: "kafka-mcp", url: `${config.kafkaUrl}/mcp` });
	}
	if (config.capellaUrl) {
		serverEntries.push({ name: "couchbase-mcp", url: `${config.capellaUrl}/mcp` });
	}
	if (config.konnectUrl) {
		serverEntries.push({ name: "konnect-mcp", url: `${config.konnectUrl}/mcp` });
	}
	if (config.gitlabUrl) {
		serverEntries.push({ name: "gitlab-mcp", url: `${config.gitlabUrl}/mcp` });
	}
	if (config.atlassianUrl) {
		serverEntries.push({ name: "atlassian-mcp", url: `${config.atlassianUrl}/mcp` });
	}

	if (serverEntries.length === 0) {
		logger.warn("No MCP server URLs configured. Agent will have no tools.");
		return;
	}

	// SIO-608: Store URLs for health polling (base URL without /mcp suffix)
	serverUrls = new Map(serverEntries.map(({ name, url }) => [name, url]));

	// Connect to each server independently so one failure doesn't block the rest
	const results = await Promise.allSettled(
		serverEntries.map(async ({ name, url }) => {
			// SIO-602: Inject W3C traceparent for OTEL span correlation with MCP servers.
			// SIO-649: Elastic also gets X-Elastic-Deployment via injectElasticHeaders.
			// The beforeToolCall hook is supported at runtime but missing from the TypeScript
			// type definitions in @langchain/mcp-adapters@1.1.3, hence the type assertion.
			const beforeToolCall = name === "elastic-mcp" ? injectElasticHeaders : injectTraceHeaders;
			const client = new MultiServerMCPClient({
				mcpServers: {
					[name]: {
						transport: "http",
						url,
						beforeToolCall: () => beforeToolCall(),
					} as never,
				},
			});
			const tools = await withTimeout(client.getTools(), MCP_CONNECT_TIMEOUT_MS, `MCP connect to '${name}' (${url})`);
			return { name, tools };
		}),
	);

	const tools: StructuredToolInterface[] = [];
	connectedServers = new Set();
	toolsByServer = new Map();

	for (const [i, result] of results.entries()) {
		const entry = serverEntries[i] as { name: string; url: string };
		if (result.status === "fulfilled") {
			// Patch tools with empty descriptions to prevent Bedrock validation errors
			for (const tool of result.value.tools) {
				if (!tool.description) {
					logger.warn({ serverName: entry.name, toolName: tool.name }, "Tool has empty description, patching");
					tool.description = `${tool.name} tool`;
				}
			}
			tools.push(...result.value.tools);
			connectedServers.add(result.value.name);
			toolsByServer.set(result.value.name, result.value.tools);
			logger.info({ serverName: entry.name, toolCount: result.value.tools.length }, "MCP server connected");
		} else {
			logger.warn({ serverName: entry.name, error: result.reason }, "Failed to connect to MCP server, skipping");
		}
	}

	allTools = tools;
	logger.info({ toolCount: allTools.length, servers: [...connectedServers] }, "MCP tools loaded");

	// SIO-608: Start periodic health polling
	startHealthPolling();
}

export function getConnectedServers(): string[] {
	return [...connectedServers];
}

export function getToolsForDataSource(dataSourceId: string): StructuredToolInterface[] {
	const serverMap: Record<string, string> = {
		elastic: "elastic-mcp",
		kafka: "kafka-mcp",
		couchbase: "couchbase-mcp",
		konnect: "konnect-mcp",
		gitlab: "gitlab-mcp",
		atlassian: "atlassian-mcp",
	};

	const serverName = serverMap[dataSourceId];
	if (!serverName) return allTools;

	return toolsByServer.get(serverName) ?? [];
}

export function getAllTools(): StructuredToolInterface[] {
	return allTools;
}

// SIO-608: Health check a single MCP server via its /health endpoint
async function healthCheckServer(mcpUrl: string): Promise<boolean> {
	const healthUrl = mcpUrl.replace(/\/mcp$/, "/health");
	try {
		const response = await fetch(healthUrl, {
			method: "GET",
			signal: AbortSignal.timeout(5_000),
		});
		return response.ok;
	} catch {
		return false;
	}
}

// SIO-608: Reconnect a single server that was previously down
async function reconnectServer(name: string, mcpUrl: string): Promise<void> {
	try {
		const { MultiServerMCPClient } = await import("@langchain/mcp-adapters");
		// SIO-649: Keep elastic reconnects on injectElasticHeaders so deployment routing survives.
		const beforeToolCall = name === "elastic-mcp" ? injectElasticHeaders : injectTraceHeaders;
		const client = new MultiServerMCPClient({
			mcpServers: {
				[name]: {
					transport: "http",
					url: mcpUrl,
					beforeToolCall: () => beforeToolCall(),
				} as never,
			},
		});
		const tools = await withTimeout(
			client.getTools(),
			MCP_CONNECT_TIMEOUT_MS,
			`MCP reconnect to '${name}' (${mcpUrl})`,
		);

		for (const tool of tools) {
			if (!tool.description) {
				tool.description = `${tool.name} tool`;
			}
		}

		// Remove any stale tools for this server before appending
		const staleTools = toolsByServer.get(name) ?? [];
		const staleNames = new Set(staleTools.map((t) => t.name));
		allTools = [...allTools.filter((t) => !staleNames.has(t.name)), ...tools];

		toolsByServer.set(name, tools);
		connectedServers.add(name);
		logger.info({ serverName: name, toolCount: tools.length }, "MCP server reconnected with tools");
	} catch (error) {
		logger.warn(
			{ serverName: name, error: error instanceof Error ? error.message : String(error) },
			"Failed to reconnect MCP server",
		);
	}
}

// SIO-608: Poll all servers and update connectedServers
async function pollServerHealth(): Promise<void> {
	if (isPolling) return;
	isPolling = true;

	try {
		const checks = [...serverUrls.entries()].map(async ([name, url]) => {
			const healthy = await healthCheckServer(url);
			return { name, url, healthy };
		});

		const results = await Promise.allSettled(checks);

		for (const result of results) {
			if (result.status !== "fulfilled") continue;
			const { name, url, healthy } = result.value;

			if (healthy && !connectedServers.has(name)) {
				// Server came back online
				const hasTools = (toolsByServer.get(name)?.length ?? 0) > 0;
				if (hasTools) {
					connectedServers.add(name);
					logger.info({ serverName: name }, "MCP server back online (tools cached)");
				} else {
					await reconnectServer(name, url);
				}
			} else if (!healthy && connectedServers.has(name)) {
				// Server went down
				connectedServers.delete(name);
				logger.warn({ serverName: name }, "MCP server health check failed, marking disconnected");
			}
		}
	} finally {
		isPolling = false;
	}
}

function startHealthPolling(): void {
	if (healthPollTimer) return;
	healthPollTimer = setInterval(() => {
		pollServerHealth().catch((error) => {
			logger.error({ error: error instanceof Error ? error.message : String(error) }, "Health poll cycle failed");
		});
	}, HEALTH_POLL_INTERVAL_MS);
	logger.info({ intervalMs: HEALTH_POLL_INTERVAL_MS }, "MCP health polling started");
}

export function stopHealthPolling(): void {
	if (healthPollTimer) {
		clearInterval(healthPollTimer);
		healthPollTimer = null;
		logger.info("MCP health polling stopped");
	}
}

// SIO-680/682: exported for testing only. Do not import from production code.
export { withTimeout as _withTimeoutForTest };

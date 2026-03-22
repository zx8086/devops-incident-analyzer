// agent/src/mcp-bridge.ts
import { getLogger } from "@devops-agent/observability";
import type { StructuredToolInterface } from "@langchain/core/tools";

const logger = getLogger("mcp-bridge");

export interface McpClientConfig {
	elasticUrl?: string;
	kafkaUrl?: string;
	capellaUrl?: string;
	konnectUrl?: string;
}

// SIO-595: All MCP servers use Streamable HTTP transport at /mcp
let allTools: StructuredToolInterface[] = [];
let connectedServers: Set<string> = new Set();
let toolsByServer: Map<string, StructuredToolInterface[]> = new Map();

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

	if (serverEntries.length === 0) {
		logger.warn("No MCP server URLs configured. Agent will have no tools.");
		return;
	}

	// Connect to each server independently so one failure doesn't block the rest
	const results = await Promise.allSettled(
		serverEntries.map(async ({ name, url }) => {
			const client = new MultiServerMCPClient({
				mcpServers: { [name]: { transport: "http", url } },
			});
			const tools = await client.getTools();
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
	};

	const serverName = serverMap[dataSourceId];
	if (!serverName) return allTools;

	return toolsByServer.get(serverName) ?? [];
}

export function getAllTools(): StructuredToolInterface[] {
	return allTools;
}

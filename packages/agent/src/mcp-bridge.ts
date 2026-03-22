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

export async function createMcpClient(config: McpClientConfig): Promise<void> {
	// Dynamic import to avoid hard dependency when MCP servers aren't running
	try {
		const { MultiServerMCPClient } = await import("@langchain/mcp-adapters");

		const servers: Record<string, { transport: "http"; url: string }> = {};

		if (config.elasticUrl) {
			servers["elastic-mcp"] = { transport: "http", url: `${config.elasticUrl}/mcp` };
		}
		if (config.kafkaUrl) {
			servers["kafka-mcp"] = { transport: "http", url: `${config.kafkaUrl}/mcp` };
		}
		if (config.capellaUrl) {
			servers["couchbase-mcp"] = { transport: "http", url: `${config.capellaUrl}/mcp` };
		}
		if (config.konnectUrl) {
			servers["konnect-mcp"] = { transport: "http", url: `${config.konnectUrl}/mcp` };
		}

		if (Object.keys(servers).length === 0) {
			logger.warn("No MCP server URLs configured. Agent will have no tools.");
			return;
		}

		const client = new MultiServerMCPClient({
			mcpServers: Object.fromEntries(
				Object.entries(servers).map(([name, { transport, url }]) => [name, { transport, url }]),
			),
		});
		allTools = await client.getTools();
		logger.info({ toolCount: allTools.length }, "MCP tools loaded");
	} catch (error) {
		logger.warn({ error }, "Failed to connect to MCP servers. Agent will operate without tools.");
	}
}

export function getToolsForDataSource(dataSourceId: string): StructuredToolInterface[] {
	const prefixMap: Record<string, string> = {
		elastic: "elastic-mcp",
		kafka: "kafka-mcp",
		couchbase: "couchbase-mcp",
		konnect: "konnect-mcp",
	};

	const serverPrefix = prefixMap[dataSourceId];
	if (!serverPrefix) return allTools;

	// Filter tools by their server origin
	// MultiServerMCPClient prefixes tool names with server name
	return allTools.filter((tool) => {
		const name = tool.name.toLowerCase();
		if (dataSourceId === "elastic") return name.includes("elasticsearch") || name.includes("elastic");
		if (dataSourceId === "kafka") return name.includes("kafka") || name.includes("ksql");
		if (dataSourceId === "couchbase")
			return (
				name.includes("couchbase") ||
				name.includes("sql_plus") ||
				name.includes("get_system") ||
				name.includes("get_fatal") ||
				name.includes("get_longest") ||
				name.includes("get_most")
			);
		if (dataSourceId === "konnect")
			return (
				name.includes("konnect") ||
				name.includes("control_plane") ||
				name.includes("portal") ||
				name.includes("service") ||
				name.includes("route") ||
				name.includes("plugin") ||
				name.includes("consumer") ||
				name.includes("certificate")
			);
		return false;
	});
}

export function getAllTools(): StructuredToolInterface[] {
	return allTools;
}

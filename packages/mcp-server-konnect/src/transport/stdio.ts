// src/transport/stdio.ts
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { mcpLogger } from "../utils/mcp-logger.js";

export interface StdioTransportResult {
	transport: StdioServerTransport;
	close(): Promise<void>;
}

export async function startStdioTransport(server: McpServer): Promise<StdioTransportResult> {
	const transport = new StdioServerTransport();
	await server.connect(transport);
	mcpLogger.info("transport", "MCP server connected via stdio");

	return {
		transport,
		async close() {
			try {
				await transport.close();
				mcpLogger.info("transport", "Stdio transport closed");
			} catch (error) {
				mcpLogger.error("transport", "Error closing stdio transport", {
					error: error instanceof Error ? error.message : String(error),
				});
			}
		},
	};
}

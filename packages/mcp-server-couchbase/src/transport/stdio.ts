// src/transport/stdio.ts
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { logger } from "../lib/logger.ts";

export interface StdioTransportResult {
	transport: StdioServerTransport;
	close(): Promise<void>;
}

export async function startStdioTransport(server: McpServer): Promise<StdioTransportResult> {
	const transport = new StdioServerTransport();
	await server.connect(transport);
	logger.info("MCP server connected via stdio");

	return {
		transport,
		async close() {
			try {
				await transport.close();
				logger.info("Stdio transport closed");
			} catch (error) {
				logger.error(
					{
						error: error instanceof Error ? error.message : String(error),
					},
					"Error closing stdio transport",
				);
			}
		},
	};
}

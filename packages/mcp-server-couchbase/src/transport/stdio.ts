// src/transport/stdio.ts
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createContextLogger } from "../utils/logger.ts";

const log = createContextLogger("transport");

export interface StdioTransportResult {
	transport: StdioServerTransport;
	close(): Promise<void>;
}

export async function startStdioTransport(server: McpServer): Promise<StdioTransportResult> {
	const transport = new StdioServerTransport();
	await server.connect(transport);
	log.info("MCP server connected via stdio");

	return {
		transport,
		async close() {
			try {
				await transport.close();
				log.info("Stdio transport closed");
			} catch (error) {
				log.error(
					{
						error: error instanceof Error ? error.message : String(error),
					},
					"Error closing stdio transport",
				);
			}
		},
	};
}

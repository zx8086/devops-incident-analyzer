// src/transport/stdio.ts
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createContextLogger } from "../utils/logger.ts";

const log = createContextLogger("transport-stdio");

export interface StdioTransportResult {
	close: () => Promise<void>;
}

export async function startStdioTransport(server: McpServer): Promise<StdioTransportResult> {
	const transport = new StdioServerTransport();
	await server.connect(transport);
	log.info("stdio transport ready");
	return {
		close: async () => {
			await transport.close();
		},
	};
}

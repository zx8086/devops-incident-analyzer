// src/lib/toolRegistry.ts

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { toolRegistry } from "../tools";
import { logger } from "./logger";

export class ToolRegistry {
	static registerAll(server: McpServer, bucket: any): void {
		const registered: string[] = [];

		for (const [name, toolFn] of Object.entries(toolRegistry)) {
			toolFn(server, bucket);
			registered.push(name);
		}

		logger.info("All tools registered successfully", {
			toolCount: registered.length,
			tools: registered,
		});
	}
}

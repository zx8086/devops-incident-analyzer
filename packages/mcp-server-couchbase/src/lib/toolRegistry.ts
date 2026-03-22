/* src/lib/toolRegistry.ts */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { toolRegistry } from "../tools";
import { logger } from "./logger";

export class ToolRegistry {
	private static registeredTools = new Set<string>();

	static registerAll(server: McpServer, bucket: any): void {
		Object.entries(toolRegistry).forEach(([name, toolFn]) => {
			ToolRegistry.registerTool(server, bucket, name, toolFn);
		});

		logger.info("All tools registered successfully", {
			toolCount: ToolRegistry.registeredTools.size,
			tools: Array.from(ToolRegistry.registeredTools),
		});
	}

	static registerTool(server: McpServer, bucket: any, name: string, toolFn: Function): void {
		if (ToolRegistry.registeredTools.has(name)) {
			logger.warn(`Tool already registered: ${name}`);
			return;
		}

		logger.info(`Registering tool: ${name}`);
		toolFn(server, bucket);
		ToolRegistry.registeredTools.add(name);
	}
}

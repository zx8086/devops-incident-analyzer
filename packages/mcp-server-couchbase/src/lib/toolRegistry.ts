// src/lib/toolRegistry.ts

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { toolRegistry } from "../tools";
import { traceToolCall } from "../utils/tracing";
import { logger } from "./logger";

export class ToolRegistry {
	static registerAll(server: McpServer, bucket: any): void {
		const registered: string[] = [];

		// Wrap server.tool to inject tracing around every tool handler
		const originalTool = server.tool.bind(server);
		(server as any).tool = (name: string, ...rest: any[]) => {
			// server.tool has multiple overloads; handler is always the last arg
			const args = [...rest];
			const handlerIdx = args.length - 1;
			const originalHandler = args[handlerIdx];

			if (typeof originalHandler === "function") {
				args[handlerIdx] = async (...handlerArgs: unknown[]) => {
					return traceToolCall(name, () => originalHandler(...handlerArgs));
				};
			}

			return originalTool(name, ...args);
		};

		for (const [name, toolFn] of Object.entries(toolRegistry)) {
			toolFn(server, bucket);
			registered.push(name);
		}

		// Restore original to avoid double-wrapping on re-registration
		(server as any).tool = originalTool;

		logger.info("All tools registered successfully", {
			toolCount: registered.length,
			tools: registered,
		});
	}
}

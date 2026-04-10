// src/lib/toolRegistry.ts

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Bucket } from "couchbase";
import { toolRegistry } from "../tools";
import { logger } from "../utils/logger";
import { traceToolCall } from "../utils/tracing";

export function registerAll(server: McpServer, bucket: Bucket): void {
	const registered: string[] = [];

	// Wrap server.tool to inject tracing around every tool handler
	const originalTool = server.tool.bind(server);
	const serverRecord = server as unknown as Record<string, unknown>;
	serverRecord.tool = (name: string, ...rest: unknown[]) => {
		// Tool names are already capella_-prefixed; no additional prefixing needed
		const args = [...rest];
		const handlerIdx = args.length - 1;
		const originalHandler = args[handlerIdx];

		if (typeof originalHandler === "function") {
			args[handlerIdx] = async (...handlerArgs: unknown[]) => {
				return traceToolCall(name, () => (originalHandler as (...a: unknown[]) => Promise<unknown>)(...handlerArgs));
			};
		}

		return (originalTool as unknown as (...a: unknown[]) => unknown)(name, ...args);
	};

	for (const [name, toolFn] of Object.entries(toolRegistry)) {
		toolFn(server, bucket);
		registered.push(name);
	}

	// Restore original to avoid double-wrapping on re-registration
	serverRecord.tool = originalTool;

	logger.debug({ tools: registered }, "Registered tool names");
	logger.info({ toolCount: registered.length }, "All tools registered successfully");
}

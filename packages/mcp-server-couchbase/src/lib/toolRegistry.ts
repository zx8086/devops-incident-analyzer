// src/lib/toolRegistry.ts

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Bucket } from "couchbase";
import { toolRegistry } from "../tools";
import { traceToolCall } from "../utils/tracing";
import { logger } from "./logger";

export class ToolRegistry {
	static registerAll(server: McpServer, bucket: Bucket): void {
		const registered: string[] = [];

		// Wrap server.tool to inject tracing around every tool handler
		const originalTool = server.tool.bind(server);
		const serverRecord = server as unknown as Record<string, unknown>;
		serverRecord.tool = (name: string, ...rest: unknown[]) => {
			const prefixedName = `capella_${name}`;
			// server.tool has multiple overloads; handler is always the last arg
			const args = [...rest];
			const handlerIdx = args.length - 1;
			const originalHandler = args[handlerIdx];

			if (typeof originalHandler === "function") {
				args[handlerIdx] = async (...handlerArgs: unknown[]) => {
					return traceToolCall(prefixedName, () =>
						(originalHandler as (...a: unknown[]) => Promise<unknown>)(...handlerArgs),
					);
				};
			}

			return (originalTool as unknown as (...a: unknown[]) => unknown)(prefixedName, ...args);
		};

		for (const [name, toolFn] of Object.entries(toolRegistry)) {
			toolFn(server, bucket);
			registered.push(`capella_${name}`);
		}

		// Restore original to avoid double-wrapping on re-registration
		serverRecord.tool = originalTool;

		logger.info(
			{
				toolCount: registered.length,
				tools: registered,
			},
			"All tools registered successfully",
		);
	}
}

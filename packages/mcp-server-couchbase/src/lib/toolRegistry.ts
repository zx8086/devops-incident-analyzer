// src/lib/toolRegistry.ts

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Bucket } from "couchbase";
import { toolRegistry } from "../tools";
import { logger } from "../utils/logger";
import { traceToolCall } from "../utils/tracing";

// SIO-1419 (CodeRabbit): wrap a registerTool handler with traceToolCall. Exported for
// the toolRegistry regression test, which asserts every registry tool's registered
// handler carries the marker name -- the sugar->registerTool conversion silently
// bypassed the old server.tool wrap, losing tracing for all registry tools.
export function wrapWithToolTracing(name: string, handler: unknown): unknown {
	if (typeof handler !== "function") return handler;
	const traced = async (...handlerArgs: unknown[]) =>
		traceToolCall(name, () => (handler as (...a: unknown[]) => Promise<unknown>)(...handlerArgs));
	// Marker so tests can prove the wrapper intercepted registration; .name has no
	// runtime behavior.
	Object.defineProperty(traced, "name", { value: `traced:${name}` });
	return traced;
}

export function registerAll(server: McpServer, bucket: Bucket): void {
	const registered: string[] = [];

	// Wrap server.registerTool to inject tracing around every tool handler. The leaf
	// files register via registerTool config style (SIO-1419); wrapping server.tool
	// here would no longer intercept anything.
	const originalRegisterTool = server.registerTool.bind(server);
	const serverRecord = server as unknown as Record<string, unknown>;
	serverRecord.registerTool = (name: string, config: unknown, handler: unknown) => {
		// Tool names are already capella_-prefixed; no additional prefixing needed
		return (originalRegisterTool as unknown as (...a: unknown[]) => unknown)(
			name,
			config,
			wrapWithToolTracing(name, handler),
		);
	};

	for (const [name, toolFn] of Object.entries(toolRegistry)) {
		toolFn(server, bucket);
		registered.push(name);
	}

	// Restore original to avoid double-wrapping on re-registration
	serverRecord.registerTool = originalRegisterTool;

	logger.debug({ tools: registered }, "Registered tool names");
	logger.info({ toolCount: registered.length }, "All tools registered successfully");
}

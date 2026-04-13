// src/tools/proxy/index.ts

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { GitLabMcpProxy, ProxyToolInfo } from "../../gitlab-client/proxy.js";
import { createContextLogger } from "../../utils/logger.js";
import { traceToolCall } from "../../utils/tracing.js";

const log = createContextLogger("proxy-tools");

const TOOL_PREFIX = "gitlab_";

function buildZodShapeFromJsonSchema(inputSchema: ProxyToolInfo["inputSchema"]): Record<string, z.ZodTypeAny> {
	const properties = inputSchema.properties ?? {};
	const required = new Set(inputSchema.required ?? []);
	const shape: Record<string, z.ZodTypeAny> = {};

	for (const [key, _prop] of Object.entries(properties)) {
		const field = z.unknown().describe(key);
		shape[key] = required.has(key) ? field : field.optional();
	}

	return shape;
}

// Synchronous registration using pre-discovered tools
export function registerProxyTools(server: McpServer, proxy: GitLabMcpProxy, remoteTools: ProxyToolInfo[]): number {
	const registered: string[] = [];

	for (const tool of remoteTools) {
		const prefixedName = tool.name.startsWith(TOOL_PREFIX) ? tool.name : `${TOOL_PREFIX}${tool.name}`;
		const zodShape = buildZodShapeFromJsonSchema(tool.inputSchema);

		const handler = async (args: Record<string, unknown>) => {
			return traceToolCall(prefixedName, async () => {
				try {
					const result = (await proxy.callTool(tool.name, args)) as {
						content?: Array<{ type: string; text: string }>;
					};
					const content = (result.content ?? []).map((c) => ({
						type: "text" as const,
						text: typeof c.text === "string" ? c.text : JSON.stringify(c),
					}));
					return { content };
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					log.error({ tool: prefixedName, error: message }, "Proxy tool call failed");
					return {
						content: [{ type: "text" as const, text: `Error: ${message}` }],
						isError: true,
					};
				}
			});
		};

		server.tool(prefixedName, tool.description, zodShape, handler);
		registered.push(prefixedName);
	}

	log.info({ count: registered.length, tools: registered }, "Proxy tools registered");
	return registered.length;
}

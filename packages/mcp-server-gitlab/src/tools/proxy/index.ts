// src/tools/proxy/index.ts

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { GitLabMcpProxy, ProxyToolInfo } from "../../gitlab-client/proxy.js";
import { createContextLogger } from "../../utils/logger.js";
import { traceToolCall } from "../../utils/tracing.js";

const log = createContextLogger("proxy-tools");

const TOOL_PREFIX = "gitlab_";

// GitLab returns this when a project's code embeddings haven't been built yet.
// Indexing typically completes within 30-60 seconds of the first request.
const EMBEDDINGS_NOT_READY_PATTERN = /no embeddings|indexing has been started|indexing is still ongoing|try again in a few minutes/i;
const SEMANTIC_SEARCH_TOOL = "semantic_code_search";
const EMBEDDINGS_MAX_RETRIES = 3;
const EMBEDDINGS_BASE_DELAY_MS = 10_000; // 10s -> 20s -> 40s (~70s total worst case)

interface ProxyCallResult {
	content?: Array<{ type: string; text: string }>;
	isError?: boolean;
}

function isEmbeddingsNotReady(result: ProxyCallResult): boolean {
	if (!result.content) return false;
	return result.content.some((c) => typeof c.text === "string" && EMBEDDINGS_NOT_READY_PATTERN.test(c.text));
}

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

async function callWithEmbeddingsRetry(
	proxy: GitLabMcpProxy,
	toolName: string,
	prefixedName: string,
	args: Record<string, unknown>,
): Promise<ProxyCallResult> {
	let result = (await proxy.callTool(toolName, args)) as ProxyCallResult;

	if (!isEmbeddingsNotReady(result)) return result;

	for (let attempt = 1; attempt <= EMBEDDINGS_MAX_RETRIES; attempt++) {
		const delayMs = EMBEDDINGS_BASE_DELAY_MS * 2 ** (attempt - 1);
		log.warn(
			{ tool: prefixedName, attempt, delayMs, maxRetries: EMBEDDINGS_MAX_RETRIES },
			"Embeddings not ready, waiting before retry",
		);
		await new Promise((resolve) => setTimeout(resolve, delayMs));

		result = (await proxy.callTool(toolName, args)) as ProxyCallResult;
		if (!isEmbeddingsNotReady(result)) {
			log.info({ tool: prefixedName, attempt }, "Embeddings ready after retry");
			return result;
		}
	}

	log.warn({ tool: prefixedName }, "Embeddings still not ready after all retries, returning error");
	return { ...result, isError: true };
}

export function registerProxyTools(server: McpServer, proxy: GitLabMcpProxy, remoteTools: ProxyToolInfo[]): number {
	const registered: string[] = [];

	for (const tool of remoteTools) {
		const prefixedName = tool.name.startsWith(TOOL_PREFIX) ? tool.name : `${TOOL_PREFIX}${tool.name}`;
		const zodShape = buildZodShapeFromJsonSchema(tool.inputSchema);
		const isSemanticSearch = tool.name === SEMANTIC_SEARCH_TOOL;

		const handler = async (args: Record<string, unknown>) => {
			return traceToolCall(prefixedName, async () => {
				try {
					const result = isSemanticSearch
						? await callWithEmbeddingsRetry(proxy, tool.name, prefixedName, args)
						: ((await proxy.callTool(tool.name, args)) as ProxyCallResult);

					const content = (result.content ?? []).map((c) => ({
						type: "text" as const,
						text: typeof c.text === "string" ? c.text : JSON.stringify(c),
					}));

					if (result.isError) {
						return { content, isError: true };
					}
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

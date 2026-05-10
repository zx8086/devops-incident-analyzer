// src/tools/proxy/index.ts

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { GitLabRestClient } from "../../gitlab-client/index.js";
import type { GitLabMcpProxy, ProxyToolInfo } from "../../gitlab-client/proxy.js";
import { createContextLogger } from "../../utils/logger.js";
import { traceToolCall } from "../../utils/tracing.js";

const log = createContextLogger("proxy-tools");

const TOOL_PREFIX = "gitlab_";

// SIO-703: log once per process, not once per request. See server.ts for context.
let proxyToolsRegisteredLogged = false;

export function _resetProxyToolsRegisteredLoggedForTest(): void {
	proxyToolsRegisteredLogged = false;
}

export function _isProxyToolsRegisteredLoggedForTest(): boolean {
	return proxyToolsRegisteredLogged;
}

// GitLab returns this when a project's code embeddings haven't been built yet.
// First-time indexing takes 10-20 minutes per project (rate-limited to 450 embeddings/min).
const EMBEDDINGS_NOT_READY_PATTERN =
	/no embeddings|indexing has been started|indexing is still ongoing|try again in a few minutes/i;
const TIMEOUT_PATTERN = /timed?\s*out|request timeout|ETIMEDOUT|-32001/i;
const SEMANTIC_SEARCH_TOOL = "semantic_code_search";
const SEMANTIC_SEARCH_TIMEOUT_MS = 120_000; // 2 min per call (default MCP timeout is 60s)
const EMBEDDINGS_MAX_RETRIES = 1; // Single retry -- embeddings take 10-20 min, not seconds
const EMBEDDINGS_RETRY_DELAY_MS = 15_000; // 15s wait before the single retry

interface ProxyCallResult {
	content?: Array<{ type: string; text: string }>;
	isError?: boolean;
}

function isEmbeddingsNotReady(result: ProxyCallResult): boolean {
	if (!result.content) return false;
	return result.content.some((c) => typeof c.text === "string" && EMBEDDINGS_NOT_READY_PATTERN.test(c.text));
}

function jsonSchemaTypeToZod(key: string, prop: Record<string, unknown>): z.ZodTypeAny {
	const description = typeof prop.description === "string" ? prop.description : key;
	switch (prop.type) {
		case "string":
			return z.union([z.string(), z.number().transform(String)]).describe(description);
		case "number":
		case "integer":
			return z.number().describe(description);
		case "boolean":
			return z.boolean().describe(description);
		default:
			return z.unknown().describe(description);
	}
}

function buildZodShapeFromJsonSchema(inputSchema: ProxyToolInfo["inputSchema"]): Record<string, z.ZodTypeAny> {
	const properties = inputSchema.properties ?? {};
	const required = new Set(inputSchema.required ?? []);
	const shape: Record<string, z.ZodTypeAny> = {};

	for (const [key, prop] of Object.entries(properties)) {
		const field = jsonSchemaTypeToZod(key, (prop ?? {}) as Record<string, unknown>);
		shape[key] = required.has(key) ? field : field.optional();
	}

	return shape;
}

function isRetryableError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return TIMEOUT_PATTERN.test(message);
}

async function callWithEmbeddingsRetry(
	proxy: GitLabMcpProxy,
	toolName: string,
	prefixedName: string,
	args: Record<string, unknown>,
): Promise<ProxyCallResult> {
	const callOpts = { timeout: SEMANTIC_SEARCH_TIMEOUT_MS };

	for (let attempt = 0; attempt <= EMBEDDINGS_MAX_RETRIES; attempt++) {
		if (attempt > 0) {
			log.warn(
				{ tool: prefixedName, attempt, delayMs: EMBEDDINGS_RETRY_DELAY_MS },
				"Semantic search not available, waiting before retry",
			);
			await new Promise((resolve) => setTimeout(resolve, EMBEDDINGS_RETRY_DELAY_MS));
		}

		try {
			const result = (await proxy.callTool(toolName, args, callOpts)) as ProxyCallResult;
			if (!isEmbeddingsNotReady(result)) {
				if (attempt > 0) log.info({ tool: prefixedName, attempt }, "Semantic search succeeded after retry");
				return result;
			}
		} catch (error) {
			if (!isRetryableError(error)) throw error;
			log.warn(
				{ tool: prefixedName, attempt, error: error instanceof Error ? error.message : String(error) },
				"Semantic search timed out",
			);
			// On timeout, skip directly to guidance -- further retries won't help if embeddings aren't built
			return {
				content: [
					{
						type: "text",
						text: "Semantic code search timed out. Embeddings may still be indexing for this project (first-time indexing takes 10-20 minutes). Use gitlab_get_repository_tree and gitlab_get_file_content to browse code directly instead.",
					},
				],
				isError: true,
			};
		}
	}

	log.warn({ tool: prefixedName }, "Embeddings still not ready after retry");
	return {
		content: [
			{
				type: "text",
				text: "Embeddings not ready -- indexing is still in progress for this project (typically 10-20 minutes on first use). Use gitlab_get_repository_tree and gitlab_get_file_content to browse code directly instead.",
			},
		],
		isError: true,
	};
}

const SEARCH_TOOL = "search";
const BLOB_SCOPE = "blobs";

// GitLab.com blocks global blob search for all users. When the LLM passes
// scope=blobs with a project_id, try the project-scoped REST API first.
// Returns null if the REST call fails so the caller can fall back to the proxy.
async function tryBlobSearchViaRest(
	restClient: GitLabRestClient,
	args: Record<string, unknown>,
): Promise<ProxyCallResult | null> {
	const projectId = String(args.project_id);
	const search = String(args.search ?? "");
	if (!search) return null;

	try {
		log.info({ projectId, search }, "Intercepting blob search -- using project-scoped REST API");
		const results = await restClient.searchBlobs(projectId, search, { per_page: 20 });

		if (results.length === 0) {
			return { content: [{ type: "text", text: `No code matches found for "${search}" in project ${projectId}` }] };
		}

		const formatted = results.map(
			(r) => `## ${r.filename} (${r.path})\nLine ${r.startline}:\n\`\`\`\n${r.data}\n\`\`\``,
		);
		return { content: [{ type: "text", text: formatted.join("\n\n") }] };
	} catch (error) {
		log.warn(
			{ projectId, error: error instanceof Error ? error.message : String(error) },
			"Project-scoped blob search failed, falling back to proxy",
		);
		return null;
	}
}

function isBlobSearch(toolName: string, args: Record<string, unknown>): boolean {
	return toolName === SEARCH_TOOL && String(args.scope) === BLOB_SCOPE && args.project_id != null;
}

export function registerProxyTools(
	server: McpServer,
	proxy: GitLabMcpProxy,
	remoteTools: ProxyToolInfo[],
	restClient: GitLabRestClient,
): number {
	const registered: string[] = [];

	for (const tool of remoteTools) {
		const prefixedName = tool.name.startsWith(TOOL_PREFIX) ? tool.name : `${TOOL_PREFIX}${tool.name}`;
		const zodShape = buildZodShapeFromJsonSchema(tool.inputSchema);
		const isSemanticSearch = tool.name === SEMANTIC_SEARCH_TOOL;

		const handler = async (args: Record<string, unknown>) => {
			return traceToolCall(prefixedName, async () => {
				try {
					// GitLab.com blocks global blob search -- try project-scoped REST API first
					if (isBlobSearch(tool.name, args)) {
						const restResult = await tryBlobSearchViaRest(restClient, args);
						if (restResult) {
							const content = (restResult.content ?? []).map((c) => ({
								type: "text" as const,
								text: typeof c.text === "string" ? c.text : JSON.stringify(c),
							}));
							return restResult.isError ? { content, isError: true } : { content };
						}
						// REST failed -- fall through to proxy (will likely 403 but lets the LLM recover)
					}

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

	if (!proxyToolsRegisteredLogged) {
		log.info({ count: registered.length, tools: registered }, "Proxy tools registered");
		proxyToolsRegisteredLogged = true;
	}
	return registered.length;
}

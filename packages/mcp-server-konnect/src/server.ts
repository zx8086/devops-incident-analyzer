// src/server.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { KongApi } from "./api/kong-api.js";
import type { Config } from "./config/index.js";
import { ElicitationOperations } from "./tools/elicitation-tool.js";
import { getAllTools, validateToolRegistry } from "./tools/registry.js";
import { formatError } from "./utils/error-handling.js";
import { createContextLogger } from "./utils/logger.js";
import { mcpPaginator } from "./utils/pagination.js";
import { ToolPerformanceCollector } from "./utils/tool-tracer.js";
import { traceToolCall } from "./utils/tracing.js";

const log = createContextLogger("server");
const toolsLog = createContextLogger("tools");

export function createKonnectServer(api: KongApi, config: Config): McpServer {
	const server = new McpServer({
		name: config.application.name,
		version: config.application.version,
		description:
			"Comprehensive Kong Konnect API Gateway management with analytics, configuration, certificates, and more",
	});

	const performanceCollector = new ToolPerformanceCollector();
	const elicitationOps = new ElicitationOperations();

	// Validate tool registry
	const validation = validateToolRegistry();
	if (!validation.isValid) {
		log.fatal({ errors: validation.errors }, "Tool registry validation failed");
		throw new Error(`Invalid tool registry: ${validation.errors.join(", ")}`);
	}

	// Register all tools
	registerTools(server, api, performanceCollector, elicitationOps);

	// Override default tools/list handler to provide pagination
	// TEMPORARILY DISABLED: registerPaginatedToolsList(server);

	return server;
}

// TEMPORARILY DISABLED: This function is not called but kept for future reference.
// Uses low-level server protocol methods not available on McpServer.
function _registerPaginatedToolsList(_server: McpServer) {
	const server = _server as unknown as {
		setRequestHandler: (
			schema: { method: string },
			handler: (request: { params?: Record<string, unknown> }) => Promise<unknown>,
		) => void;
	};
	server.setRequestHandler({ method: "tools/list" }, async (request: { params?: Record<string, unknown> }) => {
		const allTools = getAllTools();

		try {
			// Extract pagination parameters (only cursor is in official MCP schema)
			const cursor = request.params?.cursor as string | undefined;

			// Use fixed page size since pageSize isn't in MCP schema
			// Category filtering via custom tools/categories endpoint instead

			toolsLog.debug({ cursor: cursor ? "[CURSOR]" : undefined, totalTools: allTools.length }, "Tools list requested");

			// Apply pagination (use default page size since not in MCP schema)
			const paginatedResult = mcpPaginator.paginateTools(allTools, {
				cursor,
			});

			// Transform tools to official MCP Tool schema format
			const mcpTools = paginatedResult.items.map((tool) => ({
				name: tool.method,
				description: tool.description,
				inputSchema: {
					type: "object" as const,
					properties: tool.parameters.shape || {},
					required: [],
				},
			}));

			// Prepare response according to MCP spec
			const response: Record<string, unknown> = {
				tools: mcpTools,
			};

			// Add nextCursor if more results exist
			if (paginatedResult.nextCursor) {
				response.nextCursor = paginatedResult.nextCursor;
			}

			toolsLog.debug(
				{
					returnedTools: mcpTools.length,
					hasNextPage: !!paginatedResult.nextCursor,
					categories: [...new Set(paginatedResult.items.map((t) => t.category))],
				},
				"Tools list response",
			);

			return response;
		} catch (error: unknown) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			toolsLog.error(
				{ error: errorMessage, cursor: request.params?.cursor ? "[INVALID]" : undefined },
				"Tools list pagination error",
			);

			// Return error per MCP spec for invalid cursor
			throw {
				code: -32602,
				message: "Invalid params",
				data: { error: errorMessage },
			};
		}
	});

	// Register tools/categories helper method for client navigation
	server.setRequestHandler({ method: "tools/categories" }, async (_request: { params?: Record<string, unknown> }) => {
		const allTools = getAllTools();
		const categories = mcpPaginator.getToolCategories(allTools);

		toolsLog.debug({ categoriesCount: categories.length, categories }, "Tool categories requested");

		return {
			categories: categories.map((category) => ({
				name: category,
				toolCount: allTools.filter((tool) => tool.category === category).length,
			})),
		};
	});
}

function registerTools(
	server: McpServer,
	api: KongApi,
	performanceCollector: ToolPerformanceCollector,
	elicitationOps: ElicitationOperations,
) {
	const allTools = getAllTools();

	log.info("Native MCP elicitation active");
	log.info(
		{ toolCount: allTools.length, categories: [...new Set(allTools.map((t) => t.category))] },
		"Registering tools",
	);

	allTools.forEach((tool) => {
		// SIO-670 PR0: per-tool handlers live on each tool entry; the wrapper here
		// stays in server.ts because tracing, perf metrics, and the MCP content
		// envelope are cross-cutting and identical for every tool.
		const handler = async (args: any, extra: RequestHandlerExtra<any, any>) => {
			const startTime = Date.now();
			let success = true;
			try {
				const result = await tool.handler(args, { api, elicitationOps, extra });
				const duration = Date.now() - startTime;
				performanceCollector.recordToolExecution(`konnect_${tool.method}`, duration, success);
				return {
					content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
				};
			} catch (error: any) {
				success = false;
				const duration = Date.now() - startTime;
				performanceCollector.recordToolExecution(`konnect_${tool.method}`, duration, success);
				return {
					content: [{ type: "text" as const, text: `Error: ${formatError(error)}` }],
					isError: true,
				};
			}
		};

		const prefixedName = `konnect_${tool.method}`;
		const tracedHandler = async (args: any, extra: RequestHandlerExtra<any, any>): Promise<any> =>
			traceToolCall(prefixedName, () => handler(args, extra));

		const toolParams = (tool as unknown as Record<string, unknown>).inputSchema ?? tool.parameters?.shape ?? {};
		log.debug({ method: prefixedName, category: tool.category }, "Registering tool");
		server.tool(prefixedName, tool.description, toolParams, tracedHandler);
	});

	log.info({ toolCount: allTools.length }, "All tools registered successfully");
}

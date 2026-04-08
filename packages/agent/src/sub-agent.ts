// agent/src/sub-agent.ts

import { getLogger } from "@devops-agent/observability";
import type { DataSourceResult, ToolError, ToolErrorCategory } from "@devops-agent/shared";
import type { RunnableConfig } from "@langchain/core/runnables";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { createLlm } from "./llm.ts";
import { getToolsForDataSource } from "./mcp-bridge.ts";
import { extractTextFromContent } from "./message-utils.ts";
import { buildSubAgentPrompt } from "./prompt-context.ts";
import type { AgentStateType } from "./state.ts";

const logger = getLogger("agent:sub-agent");

// SIO-626: Prevent hung MCP servers from stalling the pipeline indefinitely
const SUB_AGENT_TIMEOUT_MS = 60_000;

const AGENT_NAMES: Record<string, string> = {
	elastic: "elastic-agent",
	kafka: "kafka-agent",
	couchbase: "capella-agent",
	konnect: "konnect-agent",
};

const ERROR_PATTERNS: Array<{ category: ToolErrorCategory; patterns: RegExp[] }> = [
	{
		category: "auth",
		patterns: [
			/security_exception/i,
			/\b401\b/,
			/\b403\b/,
			/unauthorized/i,
			/forbidden/i,
			/invalid api key/i,
			/authentication/i,
			/access denied/i,
		],
	},
	{
		category: "session",
		patterns: [/session not found/i, /session expired/i, /token expired/i, /session_expired/i],
	},
	{
		category: "transient",
		patterns: [
			/timeout/i,
			/econnrefused/i,
			/econnreset/i,
			/rate limit/i,
			/\b429\b/,
			/\b503\b/,
			/circuit_breaking_exception/i,
			/too_many_requests/i,
			/socket hang up/i,
		],
	},
];

export function classifyToolError(message: string): { category: ToolErrorCategory; retryable: boolean } {
	const normalized = message.toLowerCase();
	for (const { category, patterns } of ERROR_PATTERNS) {
		if (patterns.some((p) => p.test(normalized))) {
			return { category, retryable: category === "transient" };
		}
	}
	// Unknown errors are retryable by default -- better to retry than silently drop
	return { category: "unknown", retryable: true };
}

function extractToolErrors(messages: Array<{ _getType(): string; content: unknown; name?: string }>): ToolError[] {
	const errors: ToolError[] = [];
	for (const msg of messages) {
		if (msg._getType() !== "tool") continue;
		const content = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
		// Tool messages containing error indicators
		const isError = /error|exception|failed|unauthorized|forbidden|timeout/i.test(content) && content.length < 2000; // Avoid false positives on large successful responses
		if (!isError) continue;

		const { category, retryable } = classifyToolError(content);
		errors.push({
			toolName: msg.name ?? "unknown",
			category,
			message: content.slice(0, 500),
			retryable,
		});
	}
	return errors;
}

// SIO-626: Tool name patterns for health/status queries per datasource
const HEALTH_TOOL_PATTERNS: Record<string, RegExp> = {
	elastic: /health|stats|cluster|node_info|cat_nodes|cat_indices|cat_shards|ingest_pipeline|node_stats/i,
	kafka: /cluster|topic|consumer|broker|describe|list|group/i,
	couchbase: /health|stats|cluster|node|bucket|query_service|ping/i,
	konnect: /status|health|service|route|upstream|gateway/i,
};

const HEALTH_QUERY_PATTERN = /\b(health|status|healthy|doing|ok|check|monitor)\b/i;
const MIN_FILTERED_TOOLS = 5;

function filterToolsForQuery(
	tools: StructuredToolInterface[],
	dataSourceId: string,
	query: string,
): { tools: StructuredToolInterface[]; filtered: boolean } {
	if (!HEALTH_QUERY_PATTERN.test(query)) return { tools, filtered: false };

	const pattern = HEALTH_TOOL_PATTERNS[dataSourceId];
	if (!pattern) return { tools, filtered: false };

	const filtered = tools.filter((t) => pattern.test(t.name) || pattern.test(t.description ?? ""));
	if (filtered.length < MIN_FILTERED_TOOLS) return { tools, filtered: false };

	return { tools: filtered, filtered: true };
}

export async function queryDataSource(
	state: AgentStateType,
	config?: RunnableConfig,
): Promise<Partial<AgentStateType>> {
	const dataSourceId = state.currentDataSource;
	const agentName = AGENT_NAMES[dataSourceId] ?? "elastic-agent";
	const startTime = Date.now();
	// SIO-603: Request-scoped logger with requestId and dataSourceId
	const isRetry = state.alignmentHints.length > 0;
	const log = logger.child({ requestId: state.requestId, dataSourceId, isRetry });

	log.info({ agentName }, "Sub-agent starting");

	try {
		const allTools = getToolsForDataSource(dataSourceId);
		const systemPrompt = buildSubAgentPrompt(agentName);
		const llm = createLlm("subAgent");

		if (allTools.length === 0) {
			log.warn("No MCP tools available, skipping");
			const result: DataSourceResult = {
				dataSourceId,
				data: `No tools available for ${dataSourceId}. MCP server may not be connected.`,
				status: "error",
				duration: Date.now() - startTime,
				error: "No MCP tools available",
			};
			return { dataSourceResults: [result] };
		}

		// SIO-626: Filter tools for health/status queries to reduce prompt token count
		const lastUserMessage = state.messages.filter((m) => m._getType() === "human").pop();
		const queryText = lastUserMessage ? extractTextFromContent(lastUserMessage.content) : "";
		const { tools, filtered } = filterToolsForQuery(allTools, dataSourceId, queryText);
		log.info({ toolCount: tools.length, totalTools: allTools.length, filtered }, "Creating ReAct agent with tools");

		const agent = createReactAgent({
			llm,
			tools,
			messageModifier: systemPrompt,
		});

		// Only pass the last user message to prevent cross-datasource pollution
		const messages = lastUserMessage ? [lastUserMessage] : state.messages.slice(-1);

		log.info("Invoking sub-agent");
		const response = await agent.invoke(
			{ messages },
			{
				...config,
				signal: AbortSignal.timeout(SUB_AGENT_TIMEOUT_MS),
				runName: agentName,
				metadata: {
					...config?.metadata,
					data_source_id: dataSourceId,
					request_id: state.requestId,
				},
				tags: [...(config?.tags ?? []), "sub-agent", `datasource:${dataSourceId}`],
			},
		);
		const lastResponse = response.messages.at(-1);
		const duration = Date.now() - startTime;

		const toolErrors = extractToolErrors(response.messages);
		const toolMessages = response.messages.filter((m: { _getType(): string }) => m._getType() === "tool");
		const allToolsFailed = toolMessages.length > 0 && toolErrors.length === toolMessages.length;

		log.info(
			{
				duration,
				messageCount: response.messages.length,
				responseLength: String(lastResponse?.content ?? "").length,
				toolErrorCount: toolErrors.length,
				allToolsFailed,
			},
			"Sub-agent completed",
		);

		const result: DataSourceResult = {
			dataSourceId,
			data: lastResponse ? String(lastResponse.content) : "No response from sub-agent",
			status: allToolsFailed ? "error" : "success",
			duration,
			toolOutputs: [],
			isAlignmentRetry: isRetry,
			...(toolErrors.length > 0 && { toolErrors }),
			...(allToolsFailed && { error: `All ${toolErrors.length} tool calls failed` }),
		};

		return { dataSourceResults: [result] };
	} catch (error) {
		const duration = Date.now() - startTime;
		log.error({ duration, error: error instanceof Error ? error.message : String(error) }, "Sub-agent failed");
		const result: DataSourceResult = {
			dataSourceId,
			data: null,
			status: "error",
			duration,
			isAlignmentRetry: isRetry,
			error: error instanceof Error ? error.message : String(error),
		};
		return { dataSourceResults: [result] };
	}
}

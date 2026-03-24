// agent/src/sub-agent.ts

import { getLogger } from "@devops-agent/observability";
import type { DataSourceResult, ToolError, ToolErrorCategory } from "@devops-agent/shared";
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { createLlm } from "./llm.ts";
import { getToolsForDataSource } from "./mcp-bridge.ts";
import { buildSubAgentPrompt } from "./prompt-context.ts";
import type { AgentStateType } from "./state.ts";

const logger = getLogger("agent:sub-agent");

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

export async function queryDataSource(state: AgentStateType): Promise<Partial<AgentStateType>> {
	const dataSourceId = state.currentDataSource;
	const agentName = AGENT_NAMES[dataSourceId] ?? "elastic-agent";
	const startTime = Date.now();
	// SIO-603: Request-scoped logger with requestId and dataSourceId
	const isRetry = state.alignmentHints.length > 0;
	const log = logger.child({ requestId: state.requestId, dataSourceId, isRetry });

	log.info({ agentName }, "Sub-agent starting");

	try {
		const tools = getToolsForDataSource(dataSourceId);
		const systemPrompt = buildSubAgentPrompt(agentName);
		const llm = createLlm("subAgent");

		if (tools.length === 0) {
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

		log.info({ toolCount: tools.length }, "Creating ReAct agent with tools");

		const agent = createReactAgent({
			llm,
			tools,
			messageModifier: systemPrompt,
		});

		// Only pass the last user message to prevent cross-datasource pollution
		const lastUserMessage = state.messages.filter((m) => m._getType() === "human").pop();
		const messages = lastUserMessage ? [lastUserMessage] : state.messages.slice(-1);

		log.info("Invoking sub-agent");
		const response = await agent.invoke(
			{ messages },
			{
				runName: agentName,
				metadata: { data_source_id: dataSourceId, request_id: state.requestId },
				tags: ["sub-agent", `datasource:${dataSourceId}`],
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

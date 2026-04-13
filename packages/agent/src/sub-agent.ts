// agent/src/sub-agent.ts

import type { ToolDefinition } from "@devops-agent/gitagent-bridge";
import { getAllActionToolNames, resolveActionTools } from "@devops-agent/gitagent-bridge";
import { getLogger } from "@devops-agent/observability";
import type { DataSourceResult, ToolError, ToolErrorCategory } from "@devops-agent/shared";
import type { RunnableConfig } from "@langchain/core/runnables";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { createLlm } from "./llm.ts";
import { getToolsForDataSource } from "./mcp-bridge.ts";
import { buildSubAgentPrompt, getToolDefinitionForDataSource } from "./prompt-context.ts";
import type { AgentStateType } from "./state.ts";

const logger = getLogger("agent:sub-agent");

// SIO-626: Prevent hung MCP servers from stalling the pipeline indefinitely.
// 5 minutes: sub-agents with 70+ MCP tools need multiple LLM round-trips
// (tool selection, invocation, result parsing) which routinely exceed 60s.
const SUB_AGENT_TIMEOUT_MS = 300_000;

const AGENT_NAMES: Record<string, string> = {
	elastic: "elastic-agent",
	kafka: "kafka-agent",
	couchbase: "capella-agent",
	konnect: "konnect-agent",
	gitlab: "gitlab-agent",
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
			/no embeddings/i,
			/indexing is still ongoing/i,
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

function extractToolErrors(
	messages: Array<{ _getType(): string; content: unknown; name?: string; status?: string }>,
): ToolError[] {
	const errors: ToolError[] = [];
	for (const msg of messages) {
		if (msg._getType() !== "tool") continue;
		// Use LangGraph ToolMessage.status as the error gate instead of regex on content.
		// LangGraph ToolNode sets status="error" when the tool throws (including MCP isError:true).
		// The old regex matched domain vocabulary like "totalErrorCount" causing false positives.
		if (msg.status !== "error") continue;

		const content = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
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

const MAX_TOOLS_PER_AGENT = 25;
const MIN_FILTERED_TOOLS = 5;

function selectToolsByAction(
	allTools: StructuredToolInterface[],
	dataSourceId: string,
	toolActions: Record<string, string[]> | undefined,
	toolDef: ToolDefinition | undefined,
): { tools: StructuredToolInterface[]; filtered: boolean } {
	if (allTools.length <= MAX_TOOLS_PER_AGENT) {
		return { tools: allTools, filtered: false };
	}

	if (!toolDef?.tool_mapping?.action_tool_map) {
		return { tools: allTools.slice(0, MAX_TOOLS_PER_AGENT), filtered: true };
	}

	const actions = toolActions?.[dataSourceId];
	if (actions && actions.length > 0) {
		const { toolNames } = resolveActionTools(toolDef, actions);
		if (toolNames.length > 0) {
			const nameSet = new Set(toolNames);
			const selected = allTools.filter((t) => nameSet.has(t.name));
			if (selected.length >= MIN_FILTERED_TOOLS) {
				return { tools: selected.slice(0, MAX_TOOLS_PER_AGENT), filtered: true };
			}
		}
	}

	const allActionNames = getAllActionToolNames(toolDef);
	if (allActionNames.length > 0) {
		const nameSet = new Set(allActionNames);
		const selected = allTools.filter((t) => nameSet.has(t.name));
		if (selected.length >= MIN_FILTERED_TOOLS) {
			return { tools: selected.slice(0, MAX_TOOLS_PER_AGENT), filtered: true };
		}
	}

	return { tools: allTools.slice(0, MAX_TOOLS_PER_AGENT), filtered: true };
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

		const lastUserMessage = state.messages.filter((m) => m._getType() === "human").pop();
		const toolDef = getToolDefinitionForDataSource(dataSourceId);
		const { tools, filtered } = selectToolsByAction(
			allTools,
			dataSourceId,
			state.extractedEntities.toolActions,
			toolDef,
		);
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

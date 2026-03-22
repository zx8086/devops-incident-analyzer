// agent/src/sub-agent.ts

import { getLogger } from "@devops-agent/observability";
import type { DataSourceResult } from "@devops-agent/shared";
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

const MAX_TOOL_OUTPUT_SIZE = 32_768;
const TARGET_TOOL_OUTPUT_SIZE = 16_384;

function truncateToolOutput(output: unknown): unknown {
	const str = JSON.stringify(output);
	if (str.length <= MAX_TOOL_OUTPUT_SIZE) return output;

	// Smart truncation: try to reduce arrays
	if (typeof output === "object" && output !== null) {
		const obj = output as Record<string, unknown>;
		const truncated = { ...obj, _truncated: true, _originalSize: str.length };

		for (const [key, value] of Object.entries(obj)) {
			if (Array.isArray(value) && value.length > 3) {
				(truncated as Record<string, unknown>)[key] = value.slice(0, 3);
				(truncated as Record<string, unknown>)[`_${key}Total`] = value.length;
			}
		}

		const newStr = JSON.stringify(truncated);
		if (newStr.length <= TARGET_TOOL_OUTPUT_SIZE) return truncated;
	}

	// Fallback: hard truncate
	return JSON.parse(str.slice(0, TARGET_TOOL_OUTPUT_SIZE) + '"}');
}

export async function queryDataSource(state: AgentStateType): Promise<Partial<AgentStateType>> {
	const dataSourceId = state.currentDataSource;
	const agentName = AGENT_NAMES[dataSourceId] ?? "elastic-agent";
	const startTime = Date.now();

	logger.info({ dataSourceId, agentName }, "Sub-agent starting");

	try {
		const tools = getToolsForDataSource(dataSourceId);
		const systemPrompt = buildSubAgentPrompt(agentName);
		const llm = createLlm("subAgent");

		if (tools.length === 0) {
			logger.warn({ dataSourceId }, "No MCP tools available, skipping");
			const result: DataSourceResult = {
				dataSourceId,
				data: `No tools available for ${dataSourceId}. MCP server may not be connected.`,
				status: "error",
				duration: Date.now() - startTime,
				error: "No MCP tools available",
			};
			return { dataSourceResults: [result] };
		}

		logger.info({ dataSourceId, toolCount: tools.length }, "Creating ReAct agent with tools");

		const agent = createReactAgent({
			llm,
			tools,
			messageModifier: systemPrompt,
		});

		// Only pass the last user message to prevent cross-datasource pollution
		const lastUserMessage = state.messages.filter((m) => m._getType() === "human").pop();
		const messages = lastUserMessage ? [lastUserMessage] : state.messages.slice(-1);

		logger.info({ dataSourceId }, "Invoking sub-agent");
		const response = await agent.invoke({ messages });
		const lastResponse = response.messages.at(-1);
		const duration = Date.now() - startTime;

		logger.info(
			{ dataSourceId, duration, messageCount: response.messages.length, responseLength: String(lastResponse?.content ?? "").length },
			"Sub-agent completed",
		);

		const result: DataSourceResult = {
			dataSourceId,
			data: lastResponse ? String(lastResponse.content) : "No response from sub-agent",
			status: "success",
			duration,
			toolOutputs: [],
		};

		return { dataSourceResults: [result] };
	} catch (error) {
		const duration = Date.now() - startTime;
		logger.error({ dataSourceId, duration, error: error instanceof Error ? error.message : String(error) }, "Sub-agent failed");
		const result: DataSourceResult = {
			dataSourceId,
			data: null,
			status: "error",
			duration,
			error: error instanceof Error ? error.message : String(error),
		};
		return { dataSourceResults: [result] };
	}
}

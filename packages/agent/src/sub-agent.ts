// agent/src/sub-agent.ts

import type { ToolDefinition } from "@devops-agent/gitagent-bridge";
import { getAllActionToolNames, resolveActionTools } from "@devops-agent/gitagent-bridge";
import { getLogger } from "@devops-agent/observability";
import type { DataSourceResult, ToolError, ToolErrorCategory } from "@devops-agent/shared";
import type { RunnableConfig } from "@langchain/core/runnables";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { createLlm } from "./llm.ts";
import { getToolsForDataSource, withElasticDeployment } from "./mcp-bridge.ts";
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
	atlassian: "atlassian-agent",
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

interface RunOptions {
	deploymentId?: string;
}

// SIO-649: One sub-agent invocation. Extracted so the elastic branch can call it once per
// selected deployment from queryDataSource. Non-elastic agents call it exactly once.
// Use a structural type to side-step pino's strict Logger<TLevels, TCustomLevels> generics --
// we only need the log methods here, not the full type surface.
interface LogSink {
	info: (...args: unknown[]) => unknown;
	warn: (...args: unknown[]) => unknown;
	error: (...args: unknown[]) => unknown;
	child: (bindings: Record<string, unknown>) => LogSink;
}

async function runSubAgent(
	state: AgentStateType,
	dataSourceId: string,
	agentName: string,
	isRetry: boolean,
	log: LogSink,
	config: RunnableConfig | undefined,
	options: RunOptions = {},
): Promise<DataSourceResult> {
	const startTime = Date.now();
	const { deploymentId } = options;
	try {
		const allTools = getToolsForDataSource(dataSourceId);
		const systemPrompt = buildSubAgentPrompt(agentName);
		const llm = createLlm("subAgent");

		if (allTools.length === 0) {
			log.warn({ deploymentId }, "No MCP tools available, skipping");
			return {
				dataSourceId,
				data: `No tools available for ${dataSourceId}. MCP server may not be connected.`,
				status: "error",
				duration: Date.now() - startTime,
				error: "No MCP tools available",
				...(deploymentId && { deploymentId }),
			};
		}

		const lastUserMessage = state.messages.filter((m) => m._getType() === "human").pop();
		const toolDef = getToolDefinitionForDataSource(dataSourceId);
		const { tools, filtered } = selectToolsByAction(
			allTools,
			dataSourceId,
			state.extractedEntities.toolActions,
			toolDef,
		);
		log.info(
			{ toolCount: tools.length, totalTools: allTools.length, filtered, deploymentId },
			"Creating ReAct agent with tools",
		);

		const agent = createReactAgent({
			llm,
			tools,
			messageModifier: systemPrompt,
		});

		const messages = lastUserMessage ? [lastUserMessage] : state.messages.slice(-1);

		log.info({ deploymentId }, "Invoking sub-agent");
		const response = await agent.invoke(
			{ messages },
			{
				...config,
				signal: AbortSignal.timeout(SUB_AGENT_TIMEOUT_MS),
				runName: deploymentId ? `${agentName}[${deploymentId}]` : agentName,
				metadata: {
					...config?.metadata,
					data_source_id: dataSourceId,
					request_id: state.requestId,
					...(deploymentId && { deployment_id: deploymentId }),
				},
				tags: [
					...(config?.tags ?? []),
					"sub-agent",
					`datasource:${dataSourceId}`,
					...(deploymentId ? [`deployment:${deploymentId}`] : []),
				],
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
				deploymentId,
				messageCount: response.messages.length,
				responseLength: String(lastResponse?.content ?? "").length,
				toolErrorCount: toolErrors.length,
				allToolsFailed,
			},
			"Sub-agent completed",
		);

		return {
			dataSourceId,
			data: lastResponse ? String(lastResponse.content) : "No response from sub-agent",
			status: allToolsFailed ? "error" : "success",
			duration,
			toolOutputs: [],
			isAlignmentRetry: isRetry,
			...(deploymentId && { deploymentId }),
			...(toolErrors.length > 0 && { toolErrors }),
			...(allToolsFailed && { error: `All ${toolErrors.length} tool calls failed` }),
		};
	} catch (error) {
		const duration = Date.now() - startTime;
		log.error(
			{ duration, deploymentId, error: error instanceof Error ? error.message : String(error) },
			"Sub-agent failed",
		);
		return {
			dataSourceId,
			data: null,
			status: "error",
			duration,
			isAlignmentRetry: isRetry,
			...(deploymentId && { deploymentId }),
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

export async function queryDataSource(
	state: AgentStateType,
	config?: RunnableConfig,
): Promise<Partial<AgentStateType>> {
	const dataSourceId = state.currentDataSource;
	const agentName = AGENT_NAMES[dataSourceId] ?? "elastic-agent";
	const isRetry = state.alignmentHints.length > 0;
	const log = logger.child({ requestId: state.requestId, dataSourceId, isRetry });

	log.info({ agentName }, "Sub-agent starting");

	// SIO-649: Fan out across selected deployments for elastic only. Other sub-agents ignore
	// targetDeployments entirely -- empty/unset falls through to the non-fan-out path, which
	// is the pre-SIO-649 behavior.
	const deployments = dataSourceId === "elastic" ? state.targetDeployments : [];

	if (deployments.length === 0) {
		const result = await runSubAgent(state, dataSourceId, agentName, isRetry, log, config);
		return { dataSourceResults: [result] };
	}

	log.info({ deployments }, "Elastic sub-agent fanning out across deployments");
	const results: DataSourceResult[] = [];
	// Sequential: simpler, respects MCP server rate limits, and keeps per-deployment traces ordered.
	for (const deploymentId of deployments) {
		const result = await withElasticDeployment(deploymentId, () =>
			runSubAgent(state, dataSourceId, agentName, isRetry, log, config, { deploymentId }),
		);
		results.push(result);
	}
	return { dataSourceResults: results };
}

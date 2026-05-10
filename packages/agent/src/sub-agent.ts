// agent/src/sub-agent.ts

import type { ToolDefinition } from "@devops-agent/gitagent-bridge";
import { getAllActionToolNames, resolveActionTools } from "@devops-agent/gitagent-bridge";
import { getLogger } from "@devops-agent/observability";
import type { DataSourceResult, ToolError, ToolErrorCategory } from "@devops-agent/shared";
import { redactPiiContent } from "@devops-agent/shared";
import type { RunnableConfig } from "@langchain/core/runnables";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { createLlm } from "./llm.ts";
import { getToolsForDataSource, withElasticDeployment } from "./mcp-bridge.ts";
import { buildSubAgentPrompt, getToolDefinitionForDataSource } from "./prompt-context.ts";
import type { AgentStateType } from "./state.ts";
import { instrumentTools } from "./sub-agent-instrumentation.ts";
import { getSubAgentToolCapBytes } from "./sub-agent-truncate-tool-output.ts";

const logger = getLogger("agent:sub-agent");

// SIO-626: Prevent hung MCP servers from stalling the pipeline indefinitely.
// SIO-697: Default lifted to 6 min (was 5) so deep elastic fan-outs can finish
// within the graph budget without forcing alignment retries to start with no
// runway. Tunable via SUB_AGENT_TIMEOUT_MS env var.
const SUB_AGENT_TIMEOUT_MS_DEFAULT = 360_000;

export function getSubAgentTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
	const raw = env.SUB_AGENT_TIMEOUT_MS;
	if (raw == null || raw === "") return SUB_AGENT_TIMEOUT_MS_DEFAULT;
	const parsed = Number(raw);
	if (!Number.isFinite(parsed) || parsed <= 0) return SUB_AGENT_TIMEOUT_MS_DEFAULT;
	return Math.floor(parsed);
}

// SIO-689: Trace evidence on the failing pass-4 query showed 13 LLM iterations + 12 tools-node
// executions = 25 graph steps, the LangGraph default. The 33 underlying elasticsearch_* calls were
// legitimate progressive refinement (cross-deployment 5xx triage), not looping. Lift to 40 for
// elastic only (~20 LLM iterations × ~2.75 parallel tools = ~55 tool-call budget). The 5-minute
// SUB_AGENT_TIMEOUT_MS still bounds wall-clock damage on a true loop.
const ELASTIC_RECURSION_LIMIT_DEFAULT = 40;

export function getSubAgentRecursionLimit(
	dataSourceId: string,
	env: NodeJS.ProcessEnv = process.env,
): number | undefined {
	if (dataSourceId !== "elastic") return undefined;
	const raw = env.SUBAGENT_ELASTIC_RECURSION_LIMIT;
	if (raw == null || raw === "") return ELASTIC_RECURSION_LIMIT_DEFAULT;
	const parsed = Number(raw);
	if (!Number.isFinite(parsed) || parsed <= 0) return ELASTIC_RECURSION_LIMIT_DEFAULT;
	return Math.floor(parsed);
}

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
			/oauth refresh chain expired/i,
			/oauth interactive authorization required/i,
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

// SIO-707: exported for tests. Redacts PII before ToolError.message lands in logs or state.
export function extractToolErrors(
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
		// SIO-707: redact PII before the message ever lands in logs or DataSourceResult.
		errors.push({
			toolName: msg.name ?? "unknown",
			category,
			message: redactPiiContent(content.slice(0, 500)),
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

		// SIO-686: per-tool-result observability so we can size the cap from real traces.
		// When SUBAGENT_TOOL_RESULT_CAP_BYTES is set, oversized ToolMessage.content is
		// JSON-aware truncated before re-entering the ReAct loop.
		const capBytes = getSubAgentToolCapBytes();
		const instrumentedTools = instrumentTools(tools, { dataSourceId, deploymentId, log, capBytes });

		const agent = createReactAgent({
			llm,
			tools: instrumentedTools,
			messageModifier: systemPrompt,
		});

		const messages = lastUserMessage ? [lastUserMessage] : state.messages.slice(-1);

		const recursionLimit = getSubAgentRecursionLimit(dataSourceId);
		log.info({ deploymentId, recursionLimit }, "Invoking sub-agent");
		const response = await agent.invoke(
			{ messages },
			{
				...config,
				signal: AbortSignal.timeout(getSubAgentTimeoutMs()),
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
				...(recursionLimit !== undefined && { recursionLimit }),
			},
		);
		const lastResponse = response.messages.at(-1);
		const duration = Date.now() - startTime;

		const toolErrors = extractToolErrors(response.messages);
		const toolMessages = response.messages.filter((m: { _getType(): string }) => m._getType() === "tool");
		const allToolsFailed = toolMessages.length > 0 && toolErrors.length === toolMessages.length;

		// SIO-707: emit per-failure visibility ({toolName, category, message}) alongside the count.
		// toolErrorCount is preserved for backward compatibility with existing log parsers.
		// Messages are already PII-redacted in extractToolErrors above.
		log.info(
			{
				duration,
				deploymentId,
				messageCount: response.messages.length,
				responseLength: String(lastResponse?.content ?? "").length,
				toolErrorCount: toolErrors.length,
				allToolsFailed,
				...(toolErrors.length > 0 && {
					toolErrors: toolErrors.map((e) => ({
						toolName: e.toolName,
						category: e.category,
						message: e.message,
					})),
				}),
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
			messageCount: response.messages.length,
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
	// SIO-697: an alignment retry uses retryDeployments (only the deployments that failed on
	// the first attempt), so we don't re-run siblings that already succeeded.
	const deployments =
		dataSourceId === "elastic"
			? isRetry && state.retryDeployments.length > 0
				? state.retryDeployments
				: state.targetDeployments
			: [];

	if (deployments.length === 0) {
		const result = await runSubAgent(state, dataSourceId, agentName, isRetry, log, config);
		return { dataSourceResults: [result] };
	}

	log.info({ deployments, isRetry }, "Elastic sub-agent fanning out across deployments");
	// SIO-697: parallel fan-out. withElasticDeployment is backed by AsyncLocalStorage
	// (see mcp-bridge.ts), so each branch gets its own deployment context. runSubAgent
	// catches its own errors and returns a result object, so Promise.all never rejects.
	const results = await Promise.all(
		deployments.map((deploymentId) =>
			withElasticDeployment(deploymentId, () =>
				runSubAgent(state, dataSourceId, agentName, isRetry, log, config, { deploymentId }),
			),
		),
	);
	return { dataSourceResults: results };
}

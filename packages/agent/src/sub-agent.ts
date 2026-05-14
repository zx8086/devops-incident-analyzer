// agent/src/sub-agent.ts

import type { ToolDefinition } from "@devops-agent/gitagent-bridge";
import { getAllActionToolNames, matchActionsByKeywords, resolveActionTools } from "@devops-agent/gitagent-bridge";
import { getLogger } from "@devops-agent/observability";
import type { DataSourceResult, ToolError, ToolErrorCategory } from "@devops-agent/shared";
import { redactPiiContent } from "@devops-agent/shared";
import type { RunnableConfig } from "@langchain/core/runnables";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { createLlm } from "./llm.ts";
import { getToolsForDataSource, withElasticDeployment } from "./mcp-bridge.ts";
import { extractTextFromContent } from "./message-utils.ts";
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

// SIO-728: sentinel that the kafka MCP's ResponseBuilder.error appends to the
// human error text when structured upstream fields (hostname, content-type,
// status) are available. extractToolErrors splits on this and parses the
// trailing JSON. Absent sentinel = unchanged behaviour.
const STRUCTURED_SENTINEL = "\n---STRUCTURED---\n";

// SIO-728: pick only the known structured fields off the parsed JSON. Anything
// else (forward-compat additions, junk) is ignored. The structured payload
// must never widen the ToolError shape by accident.
function pickStructuredFields(raw: unknown): {
	hostname?: string;
	upstreamContentType?: string;
	statusCode?: number;
} {
	if (raw == null || typeof raw !== "object") return {};
	const obj = raw as Record<string, unknown>;
	const out: { hostname?: string; upstreamContentType?: string; statusCode?: number } = {};
	if (typeof obj.hostname === "string") out.hostname = obj.hostname;
	if (typeof obj.upstreamContentType === "string") out.upstreamContentType = obj.upstreamContentType;
	if (typeof obj.statusCode === "number" && Number.isInteger(obj.statusCode)) out.statusCode = obj.statusCode;
	return out;
}

// SIO-707: exported for tests. Redacts PII before ToolError.message lands in logs or state.
// SIO-728: parses ---STRUCTURED--- sentinel to populate hostname/upstreamContentType/statusCode
// when the MCP server emitted them. Redaction runs on the human part only -- hostnames in the
// structured JSON would otherwise be scrubbed.
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

		// SIO-728: split off the structured payload before classifying or redacting.
		// Categorization runs on the human-readable prefix (matches today's behaviour).
		const sentinelIdx = content.indexOf(STRUCTURED_SENTINEL);
		const humanPart = sentinelIdx === -1 ? content : content.slice(0, sentinelIdx);
		let extra: { hostname?: string; upstreamContentType?: string; statusCode?: number } = {};
		if (sentinelIdx !== -1) {
			const jsonPart = content.slice(sentinelIdx + STRUCTURED_SENTINEL.length);
			try {
				extra = pickStructuredFields(JSON.parse(jsonPart));
			} catch {
				// Malformed sentinel payload -- ignore, keep going with humanPart only.
				// Don't fail the whole error-extraction path because one tool emitted bad JSON.
			}
		}

		const { category, retryable } = classifyToolError(humanPart);
		// SIO-707: redact PII before the message ever lands in logs or DataSourceResult.
		errors.push({
			toolName: msg.name ?? "unknown",
			category,
			message: redactPiiContent(humanPart.slice(0, 500)),
			retryable,
			...extra,
		});
	}
	return errors;
}

const MAX_TOOLS_PER_AGENT = 25;
const MIN_FILTERED_TOOLS = 5;

// SIO-738: Shared merge step so the augmentation test exercises the same
// dedup logic the production runSubAgent path uses. Returns baseActions
// reference unchanged when keywordActions is empty (no extra allocation).
export function mergeKeywordActions(baseActions: string[], keywordActions: string[]): string[] {
	if (keywordActions.length === 0) return baseActions;
	return [...new Set([...baseActions, ...keywordActions])];
}

// SIO-742: deterministic cluster-health action inference for the kafka sub-agent.
// The substring keyword augmenter in matchActionsByKeywords misses natural
// phrasings like "Kafka Rest" (not in action_keywords.restproxy) or "how is my
// Kafka doing" (cluster-health implied but no single keyword present). This
// function returns the full Confluent action set when the query references
// cluster health, multiple components together, or asks reachability questions,
// guaranteeing iteration-1 probes of restproxy/ksql/connect/SR.
//
// Kafka-only -- the supervisor's other sub-agents have their own keyword sets.
const CLUSTER_HEALTH_PATTERNS: RegExp[] = [
	/\bcluster\s+health\b/i,
	/\brelated\s+services\b/i,
	/\bhow\s+(is|are)\b.*\b(kafka|cluster|confluent)\b/i,
	/\bconfluent\b.*\b(rest|platform|services)\b/i,
	/\b(connect|ksql|schema\s+registry|rest\s+proxy)\b.*\b(working|up|enabled|healthy|reachable|down)\b/i,
	/\bkafka\s+(rest|connect|and)\b/i,
];

export function inferClusterHealthActions(query: string, dataSourceId: string): string[] {
	if (dataSourceId !== "kafka") return [];
	if (!query) return [];
	const matched = CLUSTER_HEALTH_PATTERNS.some((re) => re.test(query));
	if (!matched) return [];
	return ["health_check", "cluster_info", "restproxy", "ksql", "connect_status", "schema_registry"];
}

export function selectToolsByAction(
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
		// SIO-750: wrap the base sub-agent prompt with the investigation focus
		// anchor when present, so ReAct loops stay scoped to the chat session's
		// investigation rather than wandering to unrelated clusters or services.
		// We don't thread the focus through buildSubAgentPrompt itself because
		// that helper is shared with non-investigation flows.
		const baseSystemPrompt = buildSubAgentPrompt(agentName);
		const focus = state.investigationFocus;
		const focusBlock = focus
			? `\n\n---\n\nINVESTIGATION FOCUS (continuing across turns):\n- Summary: ${focus.summary}\n- Anchored services: ${focus.services.join(", ") || "(none)"}\n- Anchored time window: ${focus.timeWindow ? `${focus.timeWindow.from} to ${focus.timeWindow.to}` : "(none)"}\n\nAll tool calls must stay scoped to this investigation. Do not pivot to unrelated clusters, services, or time ranges. If the user's current message references "kafka" or "the broker" or similar pronouns, resolve them against the anchored services list, not the broadest possible interpretation.`
			: "";
		const systemPrompt = `${baseSystemPrompt}${focusBlock}`;
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

		// SIO-738: Deterministic keyword pass augments LLM-extracted actions when the
		// entity extractor omits an action despite a clear keyword in the prompt (e.g.
		// the user names "REST Proxy" or "Connect" but the LLM picks only consumer_lag
		// + cluster_info). The base toolActions still drives selection; keyword
		// matches are union-merged so non-matching prompts behave exactly as before.
		const query = lastUserMessage ? extractTextFromContent(lastUserMessage.content) : "";
		const baseActions = state.extractedEntities.toolActions?.[dataSourceId] ?? [];
		const keywordActions = toolDef ? matchActionsByKeywords(query, toolDef) : [];
		// SIO-742: cluster-health auto-include for kafka (covers phrasings the
		// substring augmenter misses, e.g. "Kafka Rest", "related services").
		const clusterHealthActions = inferClusterHealthActions(query, dataSourceId);
		const augmentationActions = mergeKeywordActions(keywordActions, clusterHealthActions);
		const mergedActions = mergeKeywordActions(baseActions, augmentationActions);
		const augmentedToolActions =
			augmentationActions.length > 0
				? { ...state.extractedEntities.toolActions, [dataSourceId]: mergedActions }
				: state.extractedEntities.toolActions;

		if (augmentationActions.length > 0) {
			log.info(
				{ dataSourceId, baseActions, keywordActions, clusterHealthActions, mergedActions, deploymentId },
				"Augmented toolActions via keyword match",
			);
		}

		const { tools, filtered } = selectToolsByAction(allTools, dataSourceId, augmentedToolActions, toolDef);
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

// packages/agent/src/sub-agent-instrumentation.ts

import { dispatchCustomEvent } from "@langchain/core/callbacks/dispatch";
import { ToolMessage } from "@langchain/core/messages";
import type { RunnableConfig } from "@langchain/core/runnables";
import type { StructuredToolInterface } from "@langchain/core/tools";
import {
	consumeEmptyAwsResultsAdvice,
	consumeInvalidQueryIdAdvice,
	createLoopGuardState,
	isGuardedTool,
	isObservedTool,
	type LoopGuardState,
	recordResult,
	reserveSignature,
	shouldShortCircuit,
	stopMessageFor,
	toolCallSignature,
} from "./sub-agent-loop-guard.ts";
import { describeToolResult } from "./sub-agent-tool-result-shape.ts";
import { truncateToolOutput } from "./sub-agent-truncate-tool-output.ts";

// SIO-785 follow-up (2026-05-18): tools whose output is consumed by typed-finding
// extractors must NOT be truncated. The byte-boundary truncator breaks JSON, so
// the downstream extractor (packages/agent/src/correlation/extractors/*.ts) sees
// an unparseable string and emits empty findings — which means the UI card has
// nothing to render. Concrete failure observed live: connect_list_connectors
// returned 226KB, was cut to 32KB, KafkaFindingsCard.connectors[] stayed empty.
//
// Add a tool name to this set when (a) it feeds an extractor and (b) the
// extractor reads structured JSON rather than raw text. Free-text tools
// (e.g. consume_messages output, query results) can still be truncated.
// SIO-1159: exported so the persistence path in sub-agent.ts applies the SAME
// exemption when capping toolOutputs[].rawJson -- extractFindings reads the
// persisted form, so truncating there defeats the in-flight skip below.
export const TYPED_FINDING_TOOLS = new Set<string>([
	// kafka extractor
	"kafka_list_consumer_groups",
	"kafka_get_consumer_group_lag",
	"kafka_list_dlq_topics",
	"kafka_describe_cluster",
	"kafka_get_cluster_info",
	"connect_list_connectors",
	"connect_get_connector_status",
	"ksql_list_queries",
	// couchbase extractor
	"capella_get_longest_running_queries",
	// gitlab extractor
	"gitlab_list_merge_requests",
	// elastic extractor (only when searching synthetics-* indices, but the
	// extractor narrows by shape so it's safe to include unconditionally).
	"elasticsearch_search",
	// SIO-785 Phase 2 (2026-05-18): aws extractor + atlassian extractor.
	"aws_cloudwatch_describe_alarms",
	"findLinkedIncidents",
]);

interface InstrumentLogger {
	info: (...args: unknown[]) => unknown;
	warn: (...args: unknown[]) => unknown;
}

export interface InstrumentContext {
	dataSourceId: string;
	deploymentId?: string;
	log: InstrumentLogger;
	// SIO-686: when set, ToolMessage content exceeding capBytes is JSON-aware truncated
	// before re-entering the ReAct loop. Disabled when null/undefined (current default).
	capBytes?: number | null;
	// Live progress signal: forwarded on each tool-call resolution so the UI can show
	// a running tool-call count under the "Querying..." pill during the fan-out.
	config?: RunnableConfig;
}

// Wraps each tool so we can observe what flows back from MCP into the ReAct loop.
// We intercept invoke() only; name, description, schema, and other metadata remain
// the original references via Proxy passthrough so LangChain's tool-binding sees
// an unchanged surface.
export function instrumentTools(tools: StructuredToolInterface[], ctx: InstrumentContext): StructuredToolInterface[] {
	// SIO-1029: per-run state shared across every tool in this sub-agent invocation.
	// The loop guard tracks consecutive-empty / duplicate elasticsearch_search calls.
	const runState = { iteration: 0, loopGuard: createLoopGuardState() };
	return tools.map((tool) => instrumentTool(tool, ctx, runState));
}

interface RunState {
	iteration: number;
	loopGuard: LoopGuardState;
}

function instrumentTool(
	tool: StructuredToolInterface,
	ctx: InstrumentContext,
	runState: RunState,
): StructuredToolInterface {
	const handler: ProxyHandler<StructuredToolInterface> = {
		get(target, prop, receiver) {
			if (prop === "invoke") {
				return async (arg: unknown, configArg?: unknown) => {
					runState.iteration += 1;
					const iteration = runState.iteration;

					// SIO-1029/SIO-1084: short-circuit a repeated/unproductive guarded
					// call (elasticsearch_search, aws_logs_start_query) before it re-hits
					// MCP, so the LLM gets an explicit terminal signal instead of another
					// silent empty. `observed` also covers aws_logs_describe_log_groups,
					// which is not guarded but must be recorded (it clears the AWS
					// re-anchor gate).
					const guarded = isGuardedTool(tool.name);
					const observed = isObservedTool(tool.name);
					const signature = guarded ? toolCallSignature(tool.name, arg) : "";
					if (guarded && shouldShortCircuit(runState.loopGuard, tool.name, signature, arg)) {
						ctx.log.info(
							{
								event: "subagent.loop_guard_stop",
								dataSourceId: ctx.dataSourceId,
								deploymentId: ctx.deploymentId,
								toolName: tool.name,
								iteration,
								unproductiveSearches: runState.loopGuard.unproductiveSearches,
							},
							"Loop guard short-circuited repeated/unproductive tool call",
						);
						return buildStopResult(arg, tool.name, runState.loopGuard);
					}

					// Reserve the signature BEFORE the await so a concurrent identical
					// guarded call (parallel tool calls from one AIMessage) is caught as a
					// duplicate rather than both slipping through pre-recordResult.
					if (guarded) reserveSignature(runState.loopGuard, tool.name, signature);

					const result = await target.invoke(
						arg as Parameters<StructuredToolInterface["invoke"]>[0],
						configArg as Parameters<StructuredToolInterface["invoke"]>[1],
					);

					if (observed) {
						recordResult(runState.loopGuard, tool.name, signature, extractContent(result), arg);
					}
					await dispatchCustomEvent(
						"subagent_progress",
						{
							dataSourceId: ctx.dataSourceId,
							deploymentId: ctx.deploymentId,
							status: "running",
							toolCallCount: iteration,
						},
						ctx.config,
					);
					const processed = processResult(result, tool.name, iteration, ctx);
					// SIO-1159: a successful-but-empty CloudWatch result never errors, so
					// nothing steers the LLM off a too-narrow window (run 270378e0: a 24h
					// window silently missed a 2-day-old incident). After consecutive
					// empty-success results, append one-shot widen advice to the result.
					if (tool.name === "aws_logs_get_query_results") {
						// SIO-1162: an invalid/expired queryId takes precedence over the widen advice
						// (an invalid id is never also an empty-success, and re-polling it is always
						// wasted). Both are appended to the tool result via rebuildResult so the
						// ToolMessage/AIMessage tool_call pairing Bedrock requires stays intact.
						const invalidIdAdvice = consumeInvalidQueryIdAdvice(runState.loopGuard);
						const advice = invalidIdAdvice ?? consumeEmptyAwsResultsAdvice(runState.loopGuard);
						if (advice) {
							ctx.log.info(
								{
									event: invalidIdAdvice ? "subagent.aws_invalid_query_id_advice" : "subagent.aws_empty_results_advice",
									dataSourceId: ctx.dataSourceId,
									deploymentId: ctx.deploymentId,
									toolName: tool.name,
									iteration,
								},
								invalidIdAdvice
									? "Appending re-anchor advice after invalid CloudWatch queryId"
									: "Appending widen-window advice after consecutive empty CloudWatch results",
							);
							return rebuildResult(processed, `${stringifyContent(extractContent(processed))}\n\n${advice}`);
						}
					}
					return processed;
				};
			}
			const value = Reflect.get(target, prop, receiver);
			return typeof value === "function" ? value.bind(target) : value;
		},
	};
	return new Proxy(tool, handler);
}

// SIO-1029: return the guard's stop message as a ToolMessage shaped like a real
// tool result. When createReactAgent's ToolNode invokes a tool it passes the
// full tool-call object ({ name, args, id }); we reuse that id so the message
// pairs with its AIMessage tool_call (Bedrock requires the pairing). SIO-1084:
// the message is tool-specific (elastic "stop searching" vs aws "re-anchor").
function buildStopResult(arg: unknown, toolName: string, state: LoopGuardState): ToolMessage {
	const toolCallId =
		arg && typeof arg === "object" && "id" in arg && typeof (arg as { id: unknown }).id === "string"
			? (arg as { id: string }).id
			: "loop-guard-stop";
	return new ToolMessage({ content: stopMessageFor(toolName, state), tool_call_id: toolCallId });
}

function processResult(result: unknown, toolName: string, iteration: number, ctx: InstrumentContext): unknown {
	const content = extractContent(result);
	const { bytes, shape } = describeToolResult(content);
	ctx.log.info(
		{
			event: "subagent.tool_result",
			dataSourceId: ctx.dataSourceId,
			deploymentId: ctx.deploymentId,
			toolName,
			iteration,
			bytes,
			contentType: shape.contentType,
			shape,
		},
		"Tool result observed",
	);

	if (ctx.capBytes == null || ctx.capBytes <= 0) return result;

	const text = stringifyContent(content);
	if (Buffer.byteLength(text, "utf8") <= ctx.capBytes) return result;

	// SIO-785 follow-up (2026-05-18): preserve raw JSON for typed-finding
	// extractors. See TYPED_FINDING_TOOLS for rationale.
	if (TYPED_FINDING_TOOLS.has(toolName)) {
		ctx.log.info(
			{
				event: "subagent.tool_result_truncation_skipped",
				dataSourceId: ctx.dataSourceId,
				deploymentId: ctx.deploymentId,
				toolName,
				iteration,
				bytes,
				reason: "typed-finding tool",
			},
			"Tool result truncation skipped to preserve typed-finding JSON",
		);
		return result;
	}

	const truncated = truncateToolOutput(text, ctx.capBytes);
	if (truncated.strategy === "none") return result;

	ctx.log.info(
		{
			event: "subagent.tool_result_truncated",
			dataSourceId: ctx.dataSourceId,
			deploymentId: ctx.deploymentId,
			toolName,
			iteration,
			originalBytes: truncated.originalBytes,
			finalBytes: truncated.finalBytes,
			strategy: truncated.strategy,
		},
		"Tool result truncated",
	);

	return rebuildResult(result, truncated.content);
}

function extractContent(result: unknown): unknown {
	if (result && typeof result === "object" && "content" in result) {
		return (result as ToolMessage).content;
	}
	return result;
}

function stringifyContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (content == null) return "";
	try {
		return JSON.stringify(content) ?? "";
	} catch {
		return String(content);
	}
}

function rebuildResult(original: unknown, newContent: string): unknown {
	if (original instanceof ToolMessage) {
		return new ToolMessage({
			content: newContent,
			tool_call_id: original.tool_call_id,
			name: original.name,
			status: original.status,
			artifact: original.artifact,
		});
	}
	if (original && typeof original === "object" && "content" in original) {
		// Plain ToolMessage-shaped object (e.g. from a fake tool); copy all fields
		// and overwrite content.
		return { ...(original as Record<string, unknown>), content: newContent };
	}
	return newContent;
}

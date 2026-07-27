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
//
// SIO-1248: this set is now a PERSISTENCE-ONLY concern. It used to ALSO skip the
// in-flight cap in processResult(), because toolOutputs[] was derived from
// response.messages -- the post-truncation ToolMessages -- so the LLM copy and the
// extractor copy were the same bytes, in series. That forced one payload to serve
// two consumers with opposite needs, and elasticsearch_search (below) rode the
// exemption straight into the ReAct context: a 233KB search result (~58k tokens)
// re-entered the loop uncapped, and six of them blew the 200k window (live run
// 2026-07-27, thread sio1247-verify: "prompt is too long: 204580 tokens").
// instrumentTools now captures the full raw content into ctx.rawOutputs BEFORE
// truncation, so the two paths are decoupled: the LLM always gets a capped copy,
// while this set keeps the persisted rawJson at full fidelity for the extractors.
// Consumed by buildPersistedToolOutput in sub-agent.ts.
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

// SIO-1248: one entry per wrapped-tool invocation, in invocation order, holding the
// UNTRUNCATED result. Raw `content` (not a string) so sub-agent.ts can apply the same
// normalizeToolContent it already uses -- elasticsearch_search returns multi-block MCP
// content (SIO-786) and normalising here would both duplicate that logic and create an
// import cycle back into sub-agent.ts.
export interface RawToolOutput {
	toolName: string;
	content: unknown;
}

export interface InstrumentContext {
	dataSourceId: string;
	deploymentId?: string;
	log: InstrumentLogger;
	// SIO-686: when set, ToolMessage content exceeding capBytes is JSON-aware truncated
	// before re-entering the ReAct loop. Disabled when null/undefined (current default).
	capBytes?: number | null;
	// SIO-1248: when provided, every invocation appends its full pre-truncation result here so
	// the persistence path can be built from raw bytes instead of the capped LLM copy.
	rawOutputs?: RawToolOutput[];
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
	const runState = { iteration: 0, toolNames: new Set<string>(), loopGuard: createLoopGuardState() };
	return tools.map((tool) => instrumentTool(tool, ctx, runState));
}

interface RunState {
	iteration: number;
	// SIO-1247: unique tool names attempted this run, so the UI can say "N calls
	// across M tools" instead of one ambiguous "N tools".
	toolNames: Set<string>;
	loopGuard: LoopGuardState;
}

function instrumentTool(
	tool: StructuredToolInterface,
	ctx: InstrumentContext,
	runState: RunState,
): StructuredToolInterface {
	// SIO-1247: one live tick per invocation attempt, fired from every exit path
	// (loop-guard short-circuit, success, throw) so the count the UI shows never lags
	// the counter. Soft by design: it runs in a finally, so a dispatch failure must
	// never replace the tool's own result or error.
	// Reports the LIVE counter, not this call's own iteration: ToolNode runs one
	// AIMessage's tool calls concurrently, so a slower earlier call resolves after a
	// faster later one. Emitting its own (smaller) iteration made the last-write-wins
	// UI count regress 2 -> 1. The live value is non-decreasing by construction.
	const emitProgress = async () => {
		const toolCallCount = runState.iteration;
		try {
			await dispatchCustomEvent(
				"subagent_progress",
				{
					dataSourceId: ctx.dataSourceId,
					deploymentId: ctx.deploymentId,
					status: "running",
					toolCallCount,
					distinctToolCount: runState.toolNames.size,
				},
				ctx.config,
			);
		} catch (error) {
			ctx.log.warn(
				{
					event: "subagent.progress_dispatch_failed",
					dataSourceId: ctx.dataSourceId,
					deploymentId: ctx.deploymentId,
					toolName: tool.name,
					toolCallCount,
					error: error instanceof Error ? error.message : String(error),
				},
				"Failed to dispatch sub-agent progress tick",
			);
		}
	};

	const handler: ProxyHandler<StructuredToolInterface> = {
		get(target, prop, receiver) {
			if (prop === "invoke") {
				return async (arg: unknown, configArg?: unknown) => {
					runState.iteration += 1;
					const iteration = runState.iteration;
					// Recorded before the guard check so a short-circuited call still counts
					// toward both numbers -- the LLM did reach for the tool.
					runState.toolNames.add(tool.name);

					try {
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
							const stop = buildStopResult(arg, tool.name, runState.loopGuard);
							// SIO-1248: capture short-circuits too. toolOutputs[] used to be derived from
							// response.messages, which includes the stop ToolMessage, so skipping it here
							// would silently drop an entry the persistence path previously had.
							ctx.rawOutputs?.push({ toolName: tool.name, content: stop.content });
							return stop;
						}

						// Reserve the signature BEFORE the await so a concurrent identical
						// guarded call (parallel tool calls from one AIMessage) is caught as a
						// duplicate rather than both slipping through pre-recordResult.
						if (guarded) reserveSignature(runState.loopGuard, tool.name, signature);

						let result: unknown;
						try {
							result = await target.invoke(
								arg as Parameters<StructuredToolInterface["invoke"]>[0],
								configArg as Parameters<StructuredToolInterface["invoke"]>[1],
							);
						} catch (error) {
							// SIO-1248: LangGraph's ToolNode converts a thrown tool error into an error
							// ToolMessage that lands in response.messages. toolOutputs[] used to be built
							// from those messages, so without capturing here the persisted list would
							// silently lose the failed call. Record it, then rethrow unchanged -- the
							// outer finally still fires SIO-1247's progress tick.
							ctx.rawOutputs?.push({
								toolName: tool.name,
								content: error instanceof Error ? error.message : String(error),
							});
							throw error;
						}

						if (observed) {
							recordResult(runState.loopGuard, tool.name, signature, extractContent(result), arg);
						}
						// SIO-1248: capture BEFORE processResult so the persisted payload is the full
						// upstream response, independent of whatever cap the LLM copy gets. Also before
						// the aws_logs_get_query_results advice append below -- that advice steers the
						// model and is not part of the tool's data.
						ctx.rawOutputs?.push({ toolName: tool.name, content: extractContent(result) });
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
										event: invalidIdAdvice
											? "subagent.aws_invalid_query_id_advice"
											: "subagent.aws_empty_results_advice",
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
					} finally {
						await emitProgress();
					}
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

	// SIO-1248: no typed-finding exemption here any more. The LLM-facing copy is ALWAYS
	// capped; extractor fidelity is preserved by the ctx.rawOutputs capture in
	// instrumentTool(), which feeds buildPersistedToolOutput's own exemption. Exempting
	// the in-flight copy is what let 233KB elasticsearch_search results into the ReAct
	// context and overflowed the 200k window.
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
		// content-ok: ToolMessage result body, not an AIMessage -- the block shape IS the payload
		// these downstream extractors parse, so it must be serialized rather than flattened to text.
		return JSON.stringify(content) ?? "";
	} catch {
		// content-ok: ToolMessage result body; last-resort branch when JSON.stringify throws (cycles).
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

// apps/web/src/lib/server/sse-pump.ts
//
// SIO-751: extracted SSE event-routing helper so both the initial /api/agent/stream
// handler and the /api/agent/topic-shift resume handler share the same logic.
// Previously the routing lived inline in stream/+server.ts.

import type { InvestigationFocus } from "@devops-agent/shared";
import { redactPiiContent } from "@devops-agent/shared";

type SendFn = (event: Record<string, unknown>) => void;
type EventStream = AsyncIterable<{
	event?: string;
	name?: string;
	tags?: string[];
	metadata?: { langgraph_node?: string };
	data?: {
		chunk?: { content?: unknown };
		output?: Record<string, unknown>;
		input?: Record<string, unknown>;
	};
}>;

const OUTPUT_NODES = new Set(["aggregate", "responder"]);
const PIPELINE_NODES = new Set([
	"classify",
	"normalize",
	"entityExtractor",
	"queryDataSource",
	"align",
	"aggregate",
	"checkConfidence",
	"validate",
	"proposeInvestigate",
	"proposeMonitor",
	"proposeEscalate",
	"aggregateMitigation",
	"responder",
	"followUp",
	// SIO-751: surface the topic-shift node in the UI's node-progress display
	// so the user sees the brief pause before the banner appears.
	"detectTopicShift",
]);
const PARTIAL_FAILURE_SOURCES = new Set([
	"proposeInvestigate",
	"proposeMonitor",
	"proposeEscalate",
	"aggregateMitigation",
	"followUp",
]);

export interface PumpResult {
	toolsUsed: string[];
	responseContent: string;
}

export async function pumpEventStream(eventStream: EventStream, send: SendFn): Promise<PumpResult> {
	const nodeStartTimes = new Map<string, number>();
	const emittedFailures = new Set<string>();
	let responseContent = "";
	const toolsUsed = new Set<string>();

	for await (const event of eventStream) {
		if (event.event === "on_chat_model_stream") {
			const chunkContent = event.data?.chunk?.content;
			if (chunkContent) {
				const tags: string[] = event.tags ?? [];
				const isOutputNode = tags.some((t: string) => OUTPUT_NODES.has(t));
				const nodeName = event.metadata?.langgraph_node;
				if (isOutputNode || (nodeName && OUTPUT_NODES.has(nodeName))) {
					const content = redactPiiContent(String(chunkContent));
					responseContent += content;
					send({ type: "message", content });
				}
			}
		}

		if (event.event === "on_chain_start" && event.name && PIPELINE_NODES.has(event.name)) {
			nodeStartTimes.set(event.name, Date.now());
			send({ type: "node_start", nodeId: event.name });
		}

		if (event.event === "on_chain_end" && event.name && PIPELINE_NODES.has(event.name)) {
			const startTime = nodeStartTimes.get(event.name);
			const duration = startTime ? Date.now() - startTime : 0;
			nodeStartTimes.delete(event.name);
			send({ type: "node_end", nodeId: event.name, duration });

			if (event.name === "followUp") {
				const suggestions = (event.data?.output as { suggestions?: unknown })?.suggestions;
				if (Array.isArray(suggestions) && suggestions.length > 0) {
					send({ type: "suggestions", suggestions });
				}
			}

			if (event.name === "checkConfidence") {
				const lowConfidence = (event.data?.output as { lowConfidence?: unknown })?.lowConfidence;
				if (lowConfidence === true) {
					send({
						type: "low_confidence",
						message: "Report confidence is below the review threshold. Results may be incomplete.",
					});
				}
			}

			if (event.name === "aggregateMitigation") {
				const pendingActions = (event.data?.output as { pendingActions?: unknown })?.pendingActions;
				if (Array.isArray(pendingActions) && pendingActions.length > 0) {
					send({ type: "pending_actions", actions: pendingActions });
				}
			}

			if (event.name && PARTIAL_FAILURE_SOURCES.has(event.name)) {
				const partialFailures = (event.data?.output as { partialFailures?: unknown })?.partialFailures;
				if (Array.isArray(partialFailures)) {
					for (const failure of partialFailures) {
						if (
							typeof failure === "object" &&
							failure !== null &&
							typeof (failure as { node?: unknown }).node === "string" &&
							typeof (failure as { reason?: unknown }).reason === "string"
						) {
							const node = (failure as { node: string }).node;
							const reason = (failure as { reason: string }).reason;
							const key = `${node}:${reason}`;
							if (!emittedFailures.has(key)) {
								emittedFailures.add(key);
								send({ type: "partial_failure", node, reason });
							}
						}
					}
				}
			}
		}

		if (event.event === "on_tool_start") {
			const toolName = event.name ?? "unknown";
			toolsUsed.add(toolName);
			send({ type: "tool_call", toolName, args: event.data?.input ?? {} });
		}
	}

	return { toolsUsed: [...toolsUsed], responseContent };
}

// SIO-751: parse the interrupt payload emitted by detectTopicShift and surface
// it to the UI. The payload shape comes from topic-shift.ts:detectTopicShift.
export function emitTopicShiftPrompt(send: SendFn, threadId: string, interruptValue: unknown): boolean {
	if (typeof interruptValue !== "object" || interruptValue === null) return false;
	const obj = interruptValue as {
		type?: unknown;
		oldFocus?: InvestigationFocus;
		newFocusCandidate?: InvestigationFocus;
		message?: unknown;
	};
	if (obj.type !== "topic_shift") return false;
	if (!obj.oldFocus || !obj.newFocusCandidate) return false;

	send({
		type: "topic_shift_prompt",
		threadId,
		oldFocusSummary: obj.oldFocus.summary,
		newFocusSummary: obj.newFocusCandidate.summary,
		oldServices: obj.oldFocus.services,
		newServices: obj.newFocusCandidate.services,
		message: typeof obj.message === "string" ? obj.message : "Topic shift detected. Continue or fresh?",
	});
	return true;
}

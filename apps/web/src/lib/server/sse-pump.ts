// apps/web/src/lib/server/sse-pump.ts
//
// SIO-751: extracted SSE event-routing helper so both the initial /api/agent/stream
// handler and the /api/agent/topic-shift resume handler share the same logic.
// Previously the routing lived inline in stream/+server.ts.

import type { InvestigationFocus } from "@devops-agent/shared";
import { HilApplyReportSchema, redactPiiContent, StreamEventSchema } from "@devops-agent/shared";
import { z } from "zod";

// SIO-1194 (CodeRabbit PR #455): validate the cap-transparency fields with Zod
// instead of manual narrowing. Parsed per-field so one malformed field drops only
// itself. Codes stay open strings by design -- unknown reason codes must flow
// through (capReasonLabel falls back to the raw code and the cap policy treats
// unknown codes as integrity/fail-closed), so an enum here would silently drop
// forward-compatible codes emitted by a newer agent.
const CapReasonsFieldSchema = z.array(z.string());
const ConfidencePreCapFieldSchema = z.number().min(0).max(1);
const LowConfidenceFieldSchema = z.boolean();

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
	// SIO-775: surface extractFindings in the pipeline display; this is also
	// where we emit datasource_result events carrying typed findings.
	"extractFindings",
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
	// elastic-iac maker graph nodes (separate graph; harmless for the incident graph).
	"bootstrap",
	"parseIntent",
	"readClusterState",
	"guard",
	"draftChange",
	"reviewPlan",
	"reviewGate",
	"openMr",
	// SIO-984: the post-MR pipeline watch -- without it the gitops flow shows "MR opened" then a
	// sudden result with no pill for the (now poll-to-terminal) watch phase. Also fires on the
	// pipeline-status "check my MR" re-check.
	"watchPipeline",
	"teardown",
	// SIO-882: elastic-iac drift sub-flow nodes.
	"detectDrift",
	"reconcileGate",
	"reconcileStack",
	"advanceDrift",
	// SIO-902: elastic-iac synthetics drift sub-flow nodes.
	"detectSyntheticsDrift",
	"syntheticsPushGate",
	"pushSynthetics",
	// SIO-935: elastic-iac fleet-upgrade sub-flow nodes. Without these the on_chain_start/
	// on_chain_end gate below drops fleet node events, so the tracing pills never light up
	// during a fleet upgrade (two-leg flow: detectFleetUpgrade -> PAUSE at fleetUpgradeGate
	// -> applyFleetUpgrade on resume).
	"detectFleetUpgrade",
	"fleetUpgradeGate",
	"applyFleetUpgrade",
	// SIO-1126: HIL learning lane nodes (incident-analyzer "learn from TICKET-123").
	"learnFetchTicket",
	"learnMatchIncident",
	"learnMatchGate",
	"learnDistill",
	"learnReviewGate",
	"applyLearnings",
]);
const PARTIAL_FAILURE_SOURCES = new Set([
	"proposeInvestigate",
	"proposeMonitor",
	"proposeEscalate",
	"aggregateMitigation",
	"followUp",
	// SIO-1146: surface applyLearnings' soft-failed KG/memory writes.
	"applyLearnings",
]);

// SIO-935: tolerant pass-through of the fleet-upgrade version partition. Returns undefined unless
// the block is a present object (old CI reports omit it), so the downstream event stays back-compatible.
function parseFleetVersionCrosstab(
	v: unknown,
): { alreadyOnTarget: number; outdated: number; versionUnknown: number; upgradeableOutdated: number } | undefined {
	if (typeof v !== "object" || v === null) return undefined;
	const o = v as Record<string, unknown>;
	const n = (x: unknown): number => (typeof x === "number" ? x : 0);
	return {
		alreadyOnTarget: n(o.alreadyOnTarget),
		outdated: n(o.outdated),
		versionUnknown: n(o.versionUnknown),
		upgradeableOutdated: n(o.upgradeableOutdated),
	};
}

export interface PumpResult {
	toolsUsed: string[];
	responseContent: string;
	// SIO-1126: true when the turn entered the HIL learning lane. The lane appends
	// its user-facing output as AIMessages (the iac idiom) instead of streaming an
	// output node, so the handlers read the final message from state when set.
	hilLearningTurn: boolean;
	// SIO-1141: the aggregate node's LLM output is streamed live (pre-cap), but the
	// gate value + post-generation rewrites (confidence cap, ungrounded/expiry
	// rewrites, verbatim DDL) are applied to finalAnswer AFTER the stream. Capture the
	// LATEST finalAnswer / confidenceScore emitted by an answer-mutating node so the
	// caller can re-emit the corrected body and the displayed report matches the gate.
	finalAnswer?: string;
	confidenceScore?: number;
	// SIO-1194: cap transparency for the done event / UI badge. Same last-writer-wins
	// capture; an empty capReasons from the correlation restore path clears an earlier
	// non-empty capture (the sole "gaps" cap was cured).
	confidencePreCap?: number;
	capReasons?: string[];
	lowConfidence?: boolean;
}

// SIO-1141: nodes that can REWRITE finalAnswer / re-cap confidenceScore after aggregate.
// enforceCorrelationsAggregate + validate run downstream of aggregate and can cap AGAIN
// (e.g. a degraded correlation rule) -- the LAST writer wins, so we keep updating.
const ANSWER_REWRITE_NODES = new Set(["aggregate", "enforceCorrelationsAggregate", "validate"]);

const HIL_LEARNING_ENTRY_NODE = "learnFetchTicket";

export async function pumpEventStream(eventStream: EventStream, send: SendFn): Promise<PumpResult> {
	const nodeStartTimes = new Map<string, number>();
	const emittedFailures = new Set<string>();
	let responseContent = "";
	let hilLearningTurn = false;
	// SIO-1141: latest rewritten finalAnswer / confidenceScore across the answer-mutating
	// nodes (aggregate then any downstream re-cap). Undefined until an answer node emits.
	let finalAnswer: string | undefined;
	let confidenceScore: number | undefined;
	// SIO-1194: cap-transparency capture (same last-writer-wins discipline).
	let confidencePreCap: number | undefined;
	let capReasons: string[] | undefined;
	let lowConfidence: boolean | undefined;
	const toolsUsed = new Set<string>();

	for await (const event of eventStream) {
		if (event.event === "on_chain_start" && event.name === HIL_LEARNING_ENTRY_NODE) {
			hilLearningTurn = true;
		}
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

		// SIO-1141: capture the corrected report body + confidence from any answer-mutating
		// node's output (aggregate streams pre-cap tokens live; the cap/rewrite lands on
		// finalAnswer AFTER generation). enforceCorrelationsAggregate is NOT a PIPELINE_NODE, so
		// this check is independent of the pill-emitting block below. Latest writer wins.
		if (event.event === "on_chain_end" && event.name && ANSWER_REWRITE_NODES.has(event.name)) {
			const output = event.data?.output as
				| {
						finalAnswer?: unknown;
						confidenceScore?: unknown;
						confidencePreCap?: unknown;
						capReasons?: unknown;
						lowConfidence?: unknown;
				  }
				| undefined;
			if (output) {
				if (typeof output.finalAnswer === "string" && output.finalAnswer.length > 0) {
					// SIO-1141: redact PII here, exactly as the streamed chunks are (line above).
					// finalAnswer is re-emitted verbatim as message_final and REPLACES the redacted
					// stream, so an unredacted capture would leak PII the stream had already scrubbed.
					finalAnswer = redactPiiContent(output.finalAnswer);
				}
				if (typeof output.confidenceScore === "number") {
					confidenceScore = output.confidenceScore;
				}
				// SIO-1194: an empty array is a meaningful write (restore path cleared the
				// caps), so present-and-valid wins over any earlier capture. Zod-parsed
				// per field; a malformed or absent field drops only itself.
				const capReasonsParsed = CapReasonsFieldSchema.safeParse(output.capReasons);
				if (capReasonsParsed.success) capReasons = capReasonsParsed.data;
				const preCapParsed = ConfidencePreCapFieldSchema.safeParse(output.confidencePreCap);
				if (preCapParsed.success) confidencePreCap = preCapParsed.data;
				const lowConfidenceParsed = LowConfidenceFieldSchema.safeParse(output.lowConfidence);
				if (lowConfidenceParsed.success) lowConfidence = lowConfidenceParsed.data;
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
				const gateLowConfidence = (event.data?.output as { lowConfidence?: unknown })?.lowConfidence;
				// SIO-1194: record the gate verdict for the done event (validate may
				// overwrite it downstream when it applies its own cap).
				if (typeof gateLowConfidence === "boolean") {
					lowConfidence = gateLowConfidence;
				}
				if (gateLowConfidence === true) {
					send({
						type: "low_confidence",
						message: "Report confidence is below the review threshold. Results may be incomplete.",
					});
				}
			}

			// SIO-775: emit one datasource_result per sub-agent result. extractFindings
			// runs after aggregate and is where kafka/gitlab/couchbase findings are
			// populated; it's the first node whose output has the typed siblings.
			if (event.name === "extractFindings") {
				const results = (event.data?.output as { dataSourceResults?: unknown })?.dataSourceResults;
				if (Array.isArray(results)) {
					for (const r of results) {
						if (typeof r !== "object" || r === null) continue;
						const result = r as {
							dataSourceId?: unknown;
							status?: unknown;
							duration?: unknown;
							error?: unknown;
							kafkaFindings?: unknown;
							gitlabFindings?: unknown;
							couchbaseFindings?: unknown;
							elasticFindings?: unknown;
							awsFindings?: unknown;
							atlassianFindings?: unknown;
						};
						if (typeof result.dataSourceId !== "string") continue;
						if (result.status !== "success" && result.status !== "error") continue;
						// SIO-785 follow-up: emit datasource_progress so the store's
						// dataSourceProgress map is populated. CompletedProgress.svelte
						// gates the Data Sources section (where findings cards mount)
						// on that map being non-empty. Without this, even valid
						// kafkaFindings have no UI row to render under.
						send({
							type: "datasource_progress",
							dataSourceId: result.dataSourceId,
							status: result.status,
							...(typeof result.error === "string" && { message: result.error }),
						});
						send({
							type: "datasource_result",
							dataSourceId: result.dataSourceId,
							status: result.status,
							...(typeof result.duration === "number" && { duration: result.duration }),
							...(typeof result.error === "string" && { error: result.error }),
							...(result.kafkaFindings !== undefined && { kafkaFindings: result.kafkaFindings }),
							...(result.gitlabFindings !== undefined && { gitlabFindings: result.gitlabFindings }),
							...(result.couchbaseFindings !== undefined && { couchbaseFindings: result.couchbaseFindings }),
							...(result.elasticFindings !== undefined && { elasticFindings: result.elasticFindings }),
							// SIO-785 Phase 2 (2026-05-18).
							...(result.awsFindings !== undefined && { awsFindings: result.awsFindings }),
							...(result.atlassianFindings !== undefined && { atlassianFindings: result.atlassianFindings }),
						});
					}
				}
			}

			if (event.name === "aggregateMitigation") {
				const pendingActions = (event.data?.output as { pendingActions?: unknown })?.pendingActions;
				if (Array.isArray(pendingActions) && pendingActions.length > 0) {
					send({ type: "pending_actions", actions: pendingActions });
				}
			}

			// SIO-1146: forward the structured apply outcome for the terminal learning
			// card. Reading the node output (not getState) means the event only fires
			// when applyLearnings actually ran this leg -- a stale report from a prior
			// learn turn can never leak into a later resume.
			if (event.name === "applyLearnings") {
				const parsed = HilApplyReportSchema.safeParse(
					(event.data?.output as { hilApplyReport?: unknown })?.hilApplyReport,
				);
				if (parsed.success) {
					send({ type: "hil_learning_applied", report: parsed.data });
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

		// Forward the queryDataSource fan-out's live per-sub-agent signal (start +
		// per-tool-call tick) so the UI can show progress during the multi-minute gap
		// between the "Querying..." and "Aligning" pipeline pills.
		if (event.event === "on_custom_event" && event.name === "subagent_progress") {
			const parsed = StreamEventSchema.safeParse({ type: "subagent_progress", ...event.data });
			if (parsed.success) send(parsed.data);
		}

		// SIO-876: forward watchPipeline's live status transitions to the UI.
		if (event.event === "on_custom_event" && event.name === "iac_pipeline_progress") {
			const data = event.data as { pipelineId?: number | null; status?: unknown; url?: unknown };
			if (typeof data?.status === "string") {
				send({
					type: "iac_pipeline_progress",
					pipelineId: data.pipelineId ?? null,
					status: data.status,
					...(typeof data.url === "string" && data.url && { url: data.url }),
				});
			}
		}

		// SIO-882: forward detectDrift's full per-stack drift report (the overview card).
		if (event.event === "on_custom_event" && event.name === "iac_drift_report") {
			const data = event.data as { deployment?: unknown; stacks?: unknown };
			if (typeof data?.deployment === "string" && Array.isArray(data.stacks)) {
				send({ type: "iac_drift_report", deployment: data.deployment, stacks: data.stacks });
			}
		}

		// SIO-882: forward each per-stack reconcile outcome as its MR opens/reuses/skips.
		if (event.event === "on_custom_event" && event.name === "iac_reconcile_result") {
			const data = event.data as {
				stack?: unknown;
				direction?: unknown;
				status?: unknown;
				mrUrl?: unknown;
				note?: unknown;
			};
			if (typeof data?.stack === "string" && typeof data?.direction === "string" && typeof data?.status === "string") {
				send({
					type: "iac_reconcile_result",
					stack: data.stack,
					direction: data.direction,
					status: data.status,
					...(typeof data.mrUrl === "string" && { mrUrl: data.mrUrl }),
					...(typeof data.note === "string" && { note: data.note }),
				});
			}
		}

		// SIO-902: forward detectSyntheticsDrift's whole-deployment report (the synthetics card).
		if (event.event === "on_custom_event" && event.name === "synthetics_drift_report") {
			const data = event.data as {
				deployment?: unknown;
				kibanaUrl?: unknown;
				kibanaSpace?: unknown;
				hasActionableDrift?: unknown;
				planError?: unknown;
				planErrorReason?: unknown;
				totals?: unknown;
				drift?: unknown;
				reconcilePlan?: unknown;
			};
			if (typeof data?.deployment === "string" && Array.isArray(data.drift)) {
				send({
					type: "synthetics_drift_report",
					deployment: data.deployment,
					kibanaUrl: typeof data.kibanaUrl === "string" ? data.kibanaUrl : "",
					kibanaSpace: typeof data.kibanaSpace === "string" ? data.kibanaSpace : "",
					hasActionableDrift: data.hasActionableDrift === true,
					...(data.planError === true && { planError: true }),
					...(typeof data.planErrorReason === "string" && { planErrorReason: data.planErrorReason }),
					totals: data.totals,
					drift: data.drift,
					reconcilePlan: data.reconcilePlan,
				});
			}
		}

		// SIO-902: forward the single synthetics push outcome.
		if (event.event === "on_custom_event" && event.name === "synthetics_push_result") {
			const data = event.data as {
				status?: unknown;
				pushedCount?: unknown;
				project?: unknown;
				pipelineId?: unknown;
				pipelineStatus?: unknown;
				note?: unknown;
			};
			if (typeof data?.status === "string") {
				send({
					type: "synthetics_push_result",
					status: data.status,
					pushedCount: typeof data.pushedCount === "number" ? data.pushedCount : 0,
					...(typeof data.project === "string" && { project: data.project }),
					...(typeof data.pipelineId === "number" && { pipelineId: data.pipelineId }),
					...(typeof data.pipelineStatus === "string" && { pipelineStatus: data.pipelineStatus }),
					...(typeof data.note === "string" && { note: data.note }),
				});
			}
		}

		// SIO-913 / SIO-922: forward detectFleetUpgrade's preview report (the fleet-upgrade card).
		if (event.event === "on_custom_event" && event.name === "fleet_upgrade_preview_report") {
			const data = event.data as {
				deployment?: unknown;
				targetVersion?: unknown;
				resolvedCount?: unknown;
				versionAvailable?: unknown;
				rolloutSeconds?: unknown;
				crosstab?: unknown;
				versionCrosstab?: unknown;
				planError?: unknown;
				planErrorReason?: unknown;
			};
			const ct = data?.crosstab as { upgradeable?: unknown; notUpgradeable?: unknown; byReason?: unknown } | undefined;
			if (typeof data?.deployment === "string" && ct) {
				const vct = parseFleetVersionCrosstab(data.versionCrosstab); // SIO-935
				send({
					type: "fleet_upgrade_preview_report",
					deployment: data.deployment,
					targetVersion: typeof data.targetVersion === "string" ? data.targetVersion : "",
					resolvedCount: typeof data.resolvedCount === "number" ? data.resolvedCount : 0,
					versionAvailable: data.versionAvailable === true,
					rolloutSeconds: typeof data.rolloutSeconds === "number" ? data.rolloutSeconds : 0,
					crosstab: {
						upgradeable: typeof ct.upgradeable === "number" ? ct.upgradeable : 0,
						notUpgradeable: typeof ct.notUpgradeable === "number" ? ct.notUpgradeable : 0,
						byReason: Array.isArray(ct.byReason)
							? ct.byReason.map((r) => {
									const x = r as { reason?: unknown; count?: unknown };
									return {
										reason: typeof x.reason === "string" ? x.reason : "",
										count: typeof x.count === "number" ? x.count : 0,
									};
								})
							: [],
					},
					...(vct && { versionCrosstab: vct }),
					...(data.planError === true && { planError: true }),
					...(typeof data.planErrorReason === "string" && { planErrorReason: data.planErrorReason }),
				});
			}
		}

		// SIO-913 / SIO-922: forward the single fleet-upgrade apply outcome.
		if (event.event === "on_custom_event" && event.name === "fleet_upgrade_apply_result") {
			const data = event.data as {
				status?: unknown;
				actionId?: unknown;
				pollStatus?: unknown;
				acked?: unknown;
				created?: unknown;
				failedSilent?: unknown;
				pipelineId?: unknown;
				pipelineUrl?: unknown;
				note?: unknown;
			};
			if (typeof data?.status === "string") {
				send({
					type: "fleet_upgrade_apply_result",
					status: data.status as "applied" | "dispatched" | "skipped" | "blocked" | "failed",
					...(typeof data.actionId === "string" && { actionId: data.actionId }),
					...(typeof data.pollStatus === "string" && { pollStatus: data.pollStatus }),
					...(typeof data.acked === "number" && { acked: data.acked }),
					...(typeof data.created === "number" && { created: data.created }),
					...(typeof data.failedSilent === "number" && { failedSilent: data.failedSilent }),
					...(typeof data.pipelineId === "number" && { pipelineId: data.pipelineId }),
					...(typeof data.pipelineUrl === "string" && data.pipelineUrl && { pipelineUrl: data.pipelineUrl }),
					...(typeof data.note === "string" && { note: data.note }),
				});
			}
		}
	}

	return {
		toolsUsed: [...toolsUsed],
		responseContent,
		hilLearningTurn,
		finalAnswer,
		confidenceScore,
		confidencePreCap,
		capReasons,
		lowConfidence,
	};
}

// SIO-1126: surface the HIL learning lane's interrupts. The match gate asks
// which stored incident the ticket corresponds to; the review gate carries the
// distilled proposal for per-item approve/reject. The UI POSTs the resume value
// to /api/agent/learning/resume.
export function emitHilLearningInterrupt(send: SendFn, threadId: string, interruptValue: unknown): boolean {
	if (typeof interruptValue !== "object" || interruptValue === null) return false;
	const obj = interruptValue as {
		type?: unknown;
		ticketKey?: unknown;
		ticketSummary?: unknown;
		candidates?: unknown;
		proposal?: unknown;
		alreadyLearned?: unknown;
		// SIO-1130: matched-investigation context for the review card.
		matchedIncidentSummary?: unknown;
		autoMatched?: unknown;
		matchCreated?: unknown;
		message?: unknown;
	};

	if (obj.type === "hil_learning_match") {
		// Filter non-object entries first: malformed checkpoint data must degrade,
		// not throw mid-SSE (CodeRabbit, PR #392).
		const candidates = Array.isArray(obj.candidates)
			? obj.candidates
					.filter((c): c is Record<string, unknown> => typeof c === "object" && c !== null)
					.map((c) => {
						const x = c as {
							id?: unknown;
							summary?: unknown;
							severity?: unknown;
							distance?: unknown;
							hasRootCause?: unknown;
							via?: unknown;
						};
						return {
							id: typeof x.id === "string" ? x.id : "",
							summary: typeof x.summary === "string" ? x.summary : "",
							severity: typeof x.severity === "string" ? x.severity : "",
							distance: typeof x.distance === "number" ? x.distance : 0,
							hasRootCause: x.hasRootCause === true,
							// SIO-1133: pass "request-id" through too (auto-confirmed, so it rarely
							// reaches the card, but keep the enum handled end-to-end).
							via: x.via === "ticket-mention" || x.via === "ticket-link" || x.via === "request-id" ? x.via : "vector",
						};
					})
			: [];
		send({
			type: "hil_learning_match",
			threadId,
			ticketKey: typeof obj.ticketKey === "string" ? obj.ticketKey : "",
			ticketSummary: typeof obj.ticketSummary === "string" ? obj.ticketSummary : "",
			candidates,
			message:
				typeof obj.message === "string" ? obj.message : "Which prior investigation does this ticket correspond to?",
		});
		return true;
	}

	if (obj.type === "hil_learning_review") {
		if (typeof obj.proposal !== "object" || obj.proposal === null) return false;
		send({
			type: "hil_learning_review",
			threadId,
			ticketKey: typeof obj.ticketKey === "string" ? obj.ticketKey : "",
			proposal: obj.proposal,
			alreadyLearned: obj.alreadyLearned === true,
			// SIO-1130: the review card shows which investigation the ticket was
			// linked to, including auto-confirmed (ticket-mention pin) matches.
			...(typeof obj.matchedIncidentSummary === "string" && { matchedIncidentSummary: obj.matchedIncidentSummary }),
			autoMatched: obj.autoMatched === true,
			matchCreated: obj.matchCreated === true,
			message:
				typeof obj.message === "string"
					? obj.message
					: "Review the distilled learnings. Approved items are written to the knowledge graph and agent memory.",
		});
		return true;
	}

	return false;
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

// elastic-iac interrupts: the maker graph pauses on either a one-line clarification
// (parseIntent) or the plan-review gate (reviewGate). Surface each to the UI; the
// UI POSTs the resume value to /api/agent/iac/resume.
export function emitIacInterrupt(send: SendFn, threadId: string, interruptValue: unknown): boolean {
	if (typeof interruptValue !== "object" || interruptValue === null) return false;
	const obj = interruptValue as {
		type?: unknown;
		message?: unknown;
		question?: unknown;
		review?: unknown;
		stack?: unknown;
		kind?: unknown;
		summary?: unknown;
		explanation?: unknown;
		resources?: unknown;
		directions?: unknown;
		// SIO-902: synthetics push gate fields.
		deployment?: unknown;
		kibanaSpace?: unknown;
		pushableCount?: unknown;
		extraCount?: unknown;
		projectScope?: unknown;
		command?: unknown;
		pushMonitors?: unknown;
		extraMonitors?: unknown;
		// SIO-913 / SIO-922: fleet upgrade apply gate fields.
		targetVersion?: unknown;
		resolvedCount?: unknown;
		upgradeableCount?: unknown;
		notUpgradeableCount?: unknown;
		rolloutSeconds?: unknown;
		byReason?: unknown;
		versionCrosstab?: unknown; // SIO-935
		priorUpgrades?: unknown; // SIO-971
	};

	if (obj.type === "iac_clarify") {
		send({
			type: "iac_clarify",
			threadId,
			question: typeof obj.question === "string" ? obj.question : "Which cluster and what change?",
		});
		return true;
	}

	if (obj.type === "iac_plan_review") {
		send({
			type: "iac_plan_review",
			threadId,
			review: obj.review ?? null,
			message:
				typeof obj.message === "string"
					? obj.message
					: "Review the Terraform plan. Approve to open a GitLab MR, or reject.",
		});
		return true;
	}

	// SIO-882: per-stack reconcile-direction gate. The UI POSTs { direction } to the
	// resume endpoint; the loop re-pauses here for the next drifted stack.
	if (obj.type === "iac_reconcile_choice") {
		const filtered = Array.isArray(obj.directions)
			? obj.directions.filter(
					(d): d is "reconcile-to-json" | "reconcile-to-live" | "skip" =>
						d === "reconcile-to-json" || d === "reconcile-to-live" || d === "skip",
				)
			: [];
		// Never emit an empty direction set (would render a choice card with no buttons);
		// reconcile-to-json + skip are always valid for any stack.
		const directions = filtered.length > 0 ? filtered : ["reconcile-to-json", "skip"];
		// SIO-886: forward the grounded explanation + per-resource detail (what drifted).
		const resources = Array.isArray(obj.resources)
			? obj.resources.map((r) => {
					const x = r as {
						address?: unknown;
						actions?: unknown;
						reason?: unknown;
						changedKeys?: unknown;
						values?: unknown;
						changes?: unknown;
						changeCount?: unknown;
						truncated?: unknown;
					};
					return {
						address: typeof x.address === "string" ? x.address : "",
						actions: Array.isArray(x.actions) ? x.actions.filter((a): a is string => typeof a === "string") : [],
						...(typeof x.reason === "string" && x.reason && { reason: x.reason }),
						...(Array.isArray(x.changedKeys) && {
							changedKeys: x.changedKeys.filter((k): k is string => typeof k === "string"),
						}),
						// SIO-900: forward the attribute-grain values + leaf-level changes[] so the choice
						// card can expand exactly which leaves drifted (the schema validates the shape).
						...(typeof x.values === "object" && x.values !== null && { values: x.values }),
						...(Array.isArray(x.changes) && { changes: x.changes }),
						...(typeof x.changeCount === "number" && { changeCount: x.changeCount }),
						...(x.truncated === true && { truncated: true }),
					};
				})
			: undefined;
		send({
			type: "iac_reconcile_choice",
			threadId,
			stack: typeof obj.stack === "string" ? obj.stack : "",
			kind: obj.kind === "unwired" ? "unwired" : "config-json",
			summary: typeof obj.summary === "string" ? obj.summary : "",
			...(typeof obj.explanation === "string" && obj.explanation && { explanation: obj.explanation }),
			...(resources && { resources }),
			directions,
			message: typeof obj.message === "string" ? obj.message : "Choose a reconcile direction for this stack.",
		});
		return true;
	}

	// SIO-902: the single synthetics push approve/decline gate. The UI POSTs { approve } to
	// the resume endpoint. extra_in_kibana is shown surface-only (never pushed).
	if (obj.type === "synthetics_push_choice") {
		const monitorsOf = (v: unknown): Array<{ project: string; monitorName: string }> =>
			Array.isArray(v)
				? v.map((m) => {
						const x = m as { project?: unknown; monitorName?: unknown };
						return {
							project: typeof x.project === "string" ? x.project : "",
							monitorName: typeof x.monitorName === "string" ? x.monitorName : "",
						};
					})
				: [];
		send({
			type: "synthetics_push_choice",
			threadId,
			deployment: typeof obj.deployment === "string" ? obj.deployment : "",
			kibanaSpace: typeof obj.kibanaSpace === "string" ? obj.kibanaSpace : "",
			pushableCount: typeof obj.pushableCount === "number" ? obj.pushableCount : 0,
			extraCount: typeof obj.extraCount === "number" ? obj.extraCount : 0,
			projectScope: typeof obj.projectScope === "string" ? obj.projectScope : null,
			command: typeof obj.command === "string" ? obj.command : "",
			...(typeof obj.explanation === "string" && obj.explanation && { explanation: obj.explanation }),
			pushMonitors: monitorsOf(obj.pushMonitors),
			extraMonitors: monitorsOf(obj.extraMonitors),
			message: typeof obj.message === "string" ? obj.message : "Approve the synthetics push to Kibana, or decline.",
		});
		return true;
	}

	// SIO-913 / SIO-922: the single fleet-upgrade apply approve/decline gate. The UI POSTs
	// { approve } to the resume endpoint; the agent then runs the imperative bulk_upgrade via CI.
	if (obj.type === "fleet_upgrade_choice") {
		const vct = parseFleetVersionCrosstab(obj.versionCrosstab); // SIO-935
		send({
			type: "fleet_upgrade_choice",
			threadId,
			deployment: typeof obj.deployment === "string" ? obj.deployment : "",
			targetVersion: typeof obj.targetVersion === "string" ? obj.targetVersion : "",
			resolvedCount: typeof obj.resolvedCount === "number" ? obj.resolvedCount : 0,
			upgradeableCount: typeof obj.upgradeableCount === "number" ? obj.upgradeableCount : 0,
			notUpgradeableCount: typeof obj.notUpgradeableCount === "number" ? obj.notUpgradeableCount : 0,
			rolloutSeconds: typeof obj.rolloutSeconds === "number" ? obj.rolloutSeconds : 0,
			byReason: Array.isArray(obj.byReason)
				? obj.byReason.map((r) => {
						const x = r as { reason?: unknown; count?: unknown };
						return {
							reason: typeof x.reason === "string" ? x.reason : "",
							count: typeof x.count === "number" ? x.count : 0,
						};
					})
				: [],
			...(vct && { versionCrosstab: vct }),
			...(typeof obj.priorUpgrades === "string" && obj.priorUpgrades ? { priorUpgrades: obj.priorUpgrades } : {}), // SIO-971
			message:
				typeof obj.message === "string" ? obj.message : "Approve the Fleet agent upgrade (runs via CI), or decline.",
		});
		return true;
	}

	return false;
}

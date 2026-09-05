// apps/web/src/lib/server/sse-pump.test.ts
// SIO-775: verify pumpEventStream emits datasource_result events with typed
// findings when extractFindings completes.
import { describe, expect, test } from "bun:test";
import { emitIacInterrupt, pumpEventStream as pumpEventStreamImpl } from "./sse-pump.ts";

type LangGraphEvent = {
	event?: string;
	name?: string;
	tags?: string[];
	// SIO-1271: mirrors the production EventStream type -- buildChatModel stamps `role` on every
	// model instance, and the pump prefers it over the node name.
	metadata?: { langgraph_node?: string; role?: string };
	data?: {
		chunk?: { content?: unknown };
		output?: Record<string, unknown>;
		input?: Record<string, unknown>;
	};
};

async function* fromArray(events: LangGraphEvent[]): AsyncIterable<LangGraphEvent> {
	for (const e of events) yield e;
}

// SIO-1641: pumpEventStream takes the node allowlist from the compiled graph (see
// getPipelineNodes in agent.ts). Tests here feed a fixed set covering every node name the
// fixtures below emit; the allowlist-specific tests at the bottom call the impl directly.
const PIPELINE: ReadonlySet<string> = new Set([
	"classify",
	"aggregate",
	"extractFindings",
	"enforceCorrelationsAggregate",
	"checkConfidence",
	"validate",
	"aggregateMitigation",
	"followUp",
	"learnFetchTicket",
	"applyLearnings",
	"openMr",
	"watchPipeline",
	"detectFleetUpgrade",
	"fleetUpgradeGate",
	"applyFleetUpgrade",
]);

function pumpEventStream(eventStream: AsyncIterable<LangGraphEvent>, send: (event: Record<string, unknown>) => void) {
	return pumpEventStreamImpl(eventStream, send, PIPELINE);
}

describe("pumpEventStream datasource_result", () => {
	test("emits one datasource_result per dataSourceResults entry on extractFindings end", async () => {
		const captured: Array<Record<string, unknown>> = [];
		const send = (event: Record<string, unknown>) => {
			captured.push(event);
		};

		await pumpEventStream(
			fromArray([
				{
					event: "on_chain_end",
					name: "extractFindings",
					data: {
						output: {
							dataSourceResults: [
								{
									dataSourceId: "kafka",
									status: "success",
									duration: 1234,
									kafkaFindings: {
										consumerGroups: [{ id: "pim-sink", state: "STABLE", totalLag: 42 }],
										dlqTopics: [{ name: "orders.dlq", totalMessages: 17, recentDelta: 3 }],
									},
								},
								{
									dataSourceId: "gitlab",
									status: "error",
									error: "MCP error -32010",
								},
							],
						},
					},
				},
			]),
			send,
		);

		const resultEvents = captured.filter((e) => e.type === "datasource_result");
		expect(resultEvents).toHaveLength(2);

		// SIO-785 follow-up: progress events emitted alongside results so the
		// store's dataSourceProgress map is populated and the Data Sources
		// section renders. Without this, findings cards have no row to mount.
		const progressEvents = captured.filter((e) => e.type === "datasource_progress");
		expect(progressEvents).toHaveLength(2);
		const kafkaProgress = progressEvents.find((e) => e.dataSourceId === "kafka");
		expect(kafkaProgress?.status).toBe("success");
		const gitlabProgress = progressEvents.find((e) => e.dataSourceId === "gitlab");
		expect(gitlabProgress?.status).toBe("error");
		expect(gitlabProgress?.message).toBe("MCP error -32010");

		const kafka = resultEvents.find((e) => e.dataSourceId === "kafka") as Record<string, unknown> | undefined;
		expect(kafka).toBeDefined();
		expect(kafka?.status).toBe("success");
		expect(kafka?.duration).toBe(1234);
		expect(kafka?.kafkaFindings).toEqual({
			consumerGroups: [{ id: "pim-sink", state: "STABLE", totalLag: 42 }],
			dlqTopics: [{ name: "orders.dlq", totalMessages: 17, recentDelta: 3 }],
		});

		const gitlab = resultEvents.find((e) => e.dataSourceId === "gitlab") as Record<string, unknown> | undefined;
		expect(gitlab?.status).toBe("error");
		expect(gitlab?.error).toBe("MCP error -32010");
		expect(gitlab?.kafkaFindings).toBeUndefined();
	});

	test("skips malformed entries silently", async () => {
		const captured: Array<Record<string, unknown>> = [];
		const send = (event: Record<string, unknown>) => {
			captured.push(event);
		};

		await pumpEventStream(
			fromArray([
				{
					event: "on_chain_end",
					name: "extractFindings",
					data: {
						output: {
							dataSourceResults: [
								null,
								{ dataSourceId: 42, status: "success" },
								{ dataSourceId: "kafka", status: "running" },
								{ dataSourceId: "kafka", status: "success" },
							],
						},
					},
				},
			]),
			send,
		);

		const resultEvents = captured.filter((e) => e.type === "datasource_result");
		expect(resultEvents).toHaveLength(1);
		expect(resultEvents[0]?.dataSourceId).toBe("kafka");
	});

	test("does nothing when output has no dataSourceResults", async () => {
		const captured: Array<Record<string, unknown>> = [];
		const send = (event: Record<string, unknown>) => {
			captured.push(event);
		};

		await pumpEventStream(
			fromArray([
				{
					event: "on_chain_end",
					name: "extractFindings",
					data: { output: {} },
				},
			]),
			send,
		);

		const resultEvents = captured.filter((e) => e.type === "datasource_result");
		expect(resultEvents).toHaveLength(0);
	});
});

describe("pumpEventStream subagent_progress", () => {
	// SIO-1247: both counts must survive the pump -- the UI renders them as
	// "3 calls across 2 tools", and dropping either half restores the old ambiguity.
	test("forwards a valid running event with the call and distinct-tool counts", async () => {
		const captured: Array<Record<string, unknown>> = [];
		const send = (event: Record<string, unknown>) => {
			captured.push(event);
		};

		await pumpEventStream(
			fromArray([
				{
					event: "on_custom_event",
					name: "subagent_progress",
					data: { dataSourceId: "kafka", status: "running", toolCallCount: 3, distinctToolCount: 2 } as unknown as {
						output?: Record<string, unknown>;
					},
				},
			]),
			send,
		);

		const events = captured.filter((e) => e.type === "subagent_progress");
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({
			dataSourceId: "kafka",
			status: "running",
			toolCallCount: 3,
			distinctToolCount: 2,
		});
	});

	test("forwards a done event scoped to a deployment (AWS multi-estate branch)", async () => {
		const captured: Array<Record<string, unknown>> = [];
		const send = (event: Record<string, unknown>) => {
			captured.push(event);
		};

		await pumpEventStream(
			fromArray([
				{
					event: "on_custom_event",
					name: "subagent_progress",
					data: { dataSourceId: "aws", deploymentId: "estate:eu-oit-prd", status: "done" } as unknown as {
						output?: Record<string, unknown>;
					},
				},
			]),
			send,
		);

		expect(captured.filter((e) => e.type === "subagent_progress")).toEqual([
			{ type: "subagent_progress", dataSourceId: "aws", deploymentId: "estate:eu-oit-prd", status: "done" },
		]);
	});

	test("drops a malformed payload (invalid status) instead of forwarding it", async () => {
		const captured: Array<Record<string, unknown>> = [];
		const send = (event: Record<string, unknown>) => {
			captured.push(event);
		};

		await pumpEventStream(
			fromArray([
				{
					event: "on_custom_event",
					name: "subagent_progress",
					data: { dataSourceId: "kafka", status: "not-a-real-status" } as unknown as {
						output?: Record<string, unknown>;
					},
				},
			]),
			send,
		);

		expect(captured.filter((e) => e.type === "subagent_progress")).toHaveLength(0);
	});

	test("drops a payload missing the required dataSourceId", async () => {
		const captured: Array<Record<string, unknown>> = [];
		const send = (event: Record<string, unknown>) => {
			captured.push(event);
		};

		await pumpEventStream(
			fromArray([
				{
					event: "on_custom_event",
					name: "subagent_progress",
					data: { status: "running" } as unknown as { output?: Record<string, unknown> },
				},
			]),
			send,
		);

		expect(captured.filter((e) => e.type === "subagent_progress")).toHaveLength(0);
	});
});

// SIO-935: the fleet-upgrade nodes were missing from PIPELINE_NODES, so their on_chain_start/
// on_chain_end events were dropped and the tracing pills never lit up. This pins the emission.
describe("pumpEventStream fleet-upgrade node progress", () => {
	test("emits node_start/node_end for the three fleet-upgrade nodes", async () => {
		const captured: Array<Record<string, unknown>> = [];
		const send = (event: Record<string, unknown>) => {
			captured.push(event);
		};

		await pumpEventStream(
			fromArray([
				{ event: "on_chain_start", name: "detectFleetUpgrade" },
				{ event: "on_chain_end", name: "detectFleetUpgrade", data: { output: {} } },
				{ event: "on_chain_start", name: "fleetUpgradeGate" },
				{ event: "on_chain_end", name: "fleetUpgradeGate", data: { output: {} } },
				{ event: "on_chain_start", name: "applyFleetUpgrade" },
				{ event: "on_chain_end", name: "applyFleetUpgrade", data: { output: {} } },
			]),
			send,
		);

		const starts = captured.filter((e) => e.type === "node_start").map((e) => e.nodeId);
		const ends = captured.filter((e) => e.type === "node_end").map((e) => e.nodeId);
		expect(starts).toEqual(["detectFleetUpgrade", "fleetUpgradeGate", "applyFleetUpgrade"]);
		expect(ends).toEqual(["detectFleetUpgrade", "fleetUpgradeGate", "applyFleetUpgrade"]);
	});
});

// SIO-984: watchPipeline was missing from PIPELINE_NODES, so the post-MR pipeline-watch phase lit no
// tracing pill (the gitops card jumped from "MR opened" to the result). This pins the emission.
describe("pumpEventStream watchPipeline node progress", () => {
	test("emits node_start/node_end for watchPipeline", async () => {
		const captured: Array<Record<string, unknown>> = [];
		const send = (event: Record<string, unknown>) => {
			captured.push(event);
		};

		await pumpEventStream(
			fromArray([
				{ event: "on_chain_start", name: "openMr" },
				{ event: "on_chain_end", name: "openMr", data: { output: {} } },
				{ event: "on_chain_start", name: "watchPipeline" },
				{ event: "on_chain_end", name: "watchPipeline", data: { output: {} } },
			]),
			send,
		);

		const starts = captured.filter((e) => e.type === "node_start").map((e) => e.nodeId);
		const ends = captured.filter((e) => e.type === "node_end").map((e) => e.nodeId);
		expect(starts).toContain("watchPipeline");
		expect(ends).toContain("watchPipeline");
	});
});

// SIO-922: the fleet-upgrade gate interrupt was never translated by emitIacInterrupt, so the UI
// got no event and rendered no card. This pins the translation that was missing.
describe("emitIacInterrupt fleet_upgrade_choice", () => {
	test("translates the gate interrupt into a fleet_upgrade_choice SSE event", () => {
		const sent: Array<Record<string, unknown>> = [];
		const handled = emitIacInterrupt((e) => sent.push(e as Record<string, unknown>), "t-fleet", {
			type: "fleet_upgrade_choice",
			deployment: "eu-b2b",
			targetVersion: "9.4.2",
			resolvedCount: 232,
			upgradeableCount: 4,
			notUpgradeableCount: 228,
			rolloutSeconds: 600,
			byReason: [{ reason: "wolfi", count: 228 }],
			message: "Approve?",
		});
		expect(handled).toBe(true);
		expect(sent).toHaveLength(1);
		expect(sent[0]).toMatchObject({
			type: "fleet_upgrade_choice",
			threadId: "t-fleet",
			deployment: "eu-b2b",
			targetVersion: "9.4.2",
			upgradeableCount: 4,
			notUpgradeableCount: 228,
		});
	});

	test("returns false for an unknown interrupt type (unchanged passthrough)", () => {
		const sent: unknown[] = [];
		expect(emitIacInterrupt((e) => sent.push(e), "t", { type: "totally_unknown" })).toBe(false);
		expect(sent).toHaveLength(0);
	});
});

// SIO-XXXX: renovateTriggerGate's interrupt was never translated by emitIacInterrupt, so the
// approve/decline gate for the renovate-integration-update sub-flow rendered nothing.
describe("emitIacInterrupt renovate_trigger_choice", () => {
	test("translates the gate interrupt into a renovate_trigger_choice SSE event", () => {
		const sent: Array<Record<string, unknown>> = [];
		const handled = emitIacInterrupt((e) => sent.push(e as Record<string, unknown>), "t-renovate", {
			type: "renovate_trigger_choice",
			marker: "renovate/elasticsearch-9.x",
			line: " - [ ] <!-- unschedule-branch=renovate/elasticsearch-9.x -->chore(deps): elasticsearch to v9.x",
			message: "Trigger the elasticsearch-9.x Renovate update?",
		});
		expect(handled).toBe(true);
		expect(sent).toHaveLength(1);
		expect(sent[0]).toMatchObject({
			type: "renovate_trigger_choice",
			threadId: "t-renovate",
			marker: "renovate/elasticsearch-9.x",
			line: " - [ ] <!-- unschedule-branch=renovate/elasticsearch-9.x -->chore(deps): elasticsearch to v9.x",
			message: "Trigger the elasticsearch-9.x Renovate update?",
		});
	});

	test("defaults marker/line/message when malformed", () => {
		const sent: Array<Record<string, unknown>> = [];
		const handled = emitIacInterrupt((e) => sent.push(e as Record<string, unknown>), "t-renovate", {
			type: "renovate_trigger_choice",
			marker: 42,
			line: null,
		});
		expect(handled).toBe(true);
		expect(sent[0]).toMatchObject({
			type: "renovate_trigger_choice",
			threadId: "t-renovate",
			marker: "",
			line: "",
			message: "Trigger this Renovate update?",
		});
	});
});

// SIO-1126: the HIL learning lane's two interrupt payloads translate to SSE
// events; the pump flags learn turns so the handlers read the final AIMessage
// from state (the lane streams no output node).
describe("emitHilLearningInterrupt", () => {
	test("translates the match-gate payload", async () => {
		const { emitHilLearningInterrupt } = await import("./sse-pump.ts");
		const sent: Array<Record<string, unknown>> = [];
		const handled = emitHilLearningInterrupt((e) => sent.push(e as Record<string, unknown>), "t-hil", {
			type: "hil_learning_match",
			ticketKey: "DEVOPS-1355",
			ticketSummary: "MSK Kafka controller election storm",
			candidates: [
				{ id: "inc-1", summary: "s", severity: "high", distance: 0.12, hasRootCause: true, via: "vector" },
				// Malformed checkpoint entries must be filtered, not crash the emit.
				null,
				{ id: "inc-2", summary: "s2", severity: "", distance: 0, hasRootCause: false, via: "ticket-mention" },
				// SIO-1133: request-id passes through; an unknown via still falls back to "vector".
				{ id: "inc-3", summary: "s3", severity: "high", distance: 0, hasRootCause: false, via: "request-id" },
				{ id: "inc-4", summary: "s4", severity: "low", distance: 0, hasRootCause: false, via: "bogus" },
			],
			message: "Pick one",
		});
		expect(handled).toBe(true);
		expect(sent[0]).toMatchObject({
			type: "hil_learning_match",
			threadId: "t-hil",
			ticketKey: "DEVOPS-1355",
			message: "Pick one",
		});
		const candidates = sent[0]?.candidates as Array<Record<string, unknown>>;
		expect(candidates).toHaveLength(4);
		expect(candidates[0]).toMatchObject({ id: "inc-1", hasRootCause: true, via: "vector" });
		expect(candidates[1]).toMatchObject({ id: "inc-2", via: "ticket-mention" });
		expect(candidates[2]).toMatchObject({ id: "inc-3", via: "request-id" });
		expect(candidates[3]).toMatchObject({ id: "inc-4", via: "vector" }); // unknown -> vector
	});

	test("translates the review-gate payload and passes the proposal through", async () => {
		const { emitHilLearningInterrupt } = await import("./sse-pump.ts");
		const sent: Array<Record<string, unknown>> = [];
		const proposal = { ticketKey: "DEVOPS-1355", rootCause: null, bindings: [], heuristics: [], memoryFacts: [] };
		const handled = emitHilLearningInterrupt((e) => sent.push(e as Record<string, unknown>), "t-hil", {
			type: "hil_learning_review",
			ticketKey: "DEVOPS-1355",
			proposal,
			alreadyLearned: true,
			message: "Review",
		});
		expect(handled).toBe(true);
		expect(sent[0]).toMatchObject({
			type: "hil_learning_review",
			threadId: "t-hil",
			alreadyLearned: true,
		});
		expect(sent[0]?.proposal).toEqual(proposal);
	});

	test("returns false for foreign payloads (topic-shift stays untouched)", async () => {
		const { emitHilLearningInterrupt } = await import("./sse-pump.ts");
		const sent: unknown[] = [];
		expect(emitHilLearningInterrupt((e) => sent.push(e), "t", { type: "topic_shift" })).toBe(false);
		expect(emitHilLearningInterrupt((e) => sent.push(e), "t", null)).toBe(false);
		expect(sent).toHaveLength(0);
	});
});

describe("pumpEventStream hilLearningTurn flag", () => {
	test("set when the lane entry node starts; false otherwise", async () => {
		const send = () => undefined;
		const learn = await pumpEventStream(fromArray([{ event: "on_chain_start", name: "learnFetchTicket" }]), send);
		expect(learn.hilLearningTurn).toBe(true);

		const normal = await pumpEventStream(fromArray([{ event: "on_chain_start", name: "classify" }]), send);
		expect(normal.hilLearningTurn).toBe(false);
	});
});

// SIO-1141: the pump captures the corrected (post-cap) finalAnswer + confidenceScore
// from answer-mutating nodes' on_chain_end, so the route can re-emit the corrected body.
describe("pumpEventStream finalAnswer/confidenceScore capture", () => {
	test("captures aggregate's rewritten finalAnswer + capped confidence", async () => {
		const send = () => undefined;
		const result = await pumpEventStream(
			fromArray([
				// The aggregate LLM streamed the pre-cap prose live (0.81)...
				{
					event: "on_chat_model_stream",
					metadata: { langgraph_node: "aggregate" },
					data: { chunk: { content: "# Report\n\nConfidence: 0.81" } },
				},
				// ...then aggregate returned the rewritten body (0.59) at chain end.
				{
					event: "on_chain_end",
					name: "aggregate",
					data: { output: { finalAnswer: "# Report\n\nConfidence: 0.59", confidenceScore: 0.59 } },
				},
			]),
			send,
		);
		expect(result.responseContent).toContain("0.81");
		expect(result.finalAnswer).toBe("# Report\n\nConfidence: 0.59");
		expect(result.confidenceScore).toBe(0.59);
	});

	test("a downstream re-cap (enforceCorrelationsAggregate) wins over aggregate", async () => {
		const send = () => undefined;
		const result = await pumpEventStream(
			fromArray([
				{
					event: "on_chain_end",
					name: "aggregate",
					data: { output: { finalAnswer: "body A\n\nConfidence: 0.72", confidenceScore: 0.72 } },
				},
				{
					event: "on_chain_end",
					name: "enforceCorrelationsAggregate",
					data: { output: { finalAnswer: "body B\n\nConfidence: 0.59", confidenceScore: 0.59 } },
				},
			]),
			send,
		);
		expect(result.finalAnswer).toBe("body B\n\nConfidence: 0.59");
		expect(result.confidenceScore).toBe(0.59);
	});

	test("leaves finalAnswer/confidenceScore undefined when no answer node ran", async () => {
		const send = () => undefined;
		const result = await pumpEventStream(fromArray([{ event: "on_chain_start", name: "classify" }]), send);
		expect(result.finalAnswer).toBeUndefined();
		expect(result.confidenceScore).toBeUndefined();
	});

	// SIO-1194: cap-transparency fields ride the same last-writer-wins capture so the
	// done event can carry confidencePreCap + capReasons to the UI badge.
	test("captures capReasons + confidencePreCap from answer-node output", async () => {
		const send = () => undefined;
		const result = await pumpEventStream(
			fromArray([
				{
					event: "on_chain_end",
					name: "aggregate",
					data: {
						output: {
							finalAnswer: "body\n\nConfidence: 0.59",
							confidenceScore: 0.59,
							confidencePreCap: 0.84,
							capReasons: ["degraded-subagents", "gaps"],
						},
					},
				},
			]),
			send,
		);
		expect(result.capReasons).toEqual(["degraded-subagents", "gaps"]);
		expect(result.confidencePreCap).toBe(0.84);
	});

	test("an empty capReasons from the correlation restore path clears an earlier capture", async () => {
		const send = () => undefined;
		const result = await pumpEventStream(
			fromArray([
				{
					event: "on_chain_end",
					name: "aggregate",
					data: { output: { confidenceScore: 0.59, confidencePreCap: 0.87, capReasons: ["gaps"] } },
				},
				{
					event: "on_chain_end",
					name: "enforceCorrelationsAggregate",
					data: { output: { confidenceScore: 0.87, capReasons: [] } },
				},
			]),
			send,
		);
		expect(result.capReasons).toEqual([]);
		expect(result.confidenceScore).toBe(0.87);
	});

	test("captures lowConfidence from checkConfidence and lets validate overwrite it", async () => {
		const send = () => undefined;
		const result = await pumpEventStream(
			fromArray([
				{ event: "on_chain_end", name: "checkConfidence", data: { output: { lowConfidence: false } } },
				{
					event: "on_chain_end",
					name: "validate",
					data: { output: { confidenceScore: 0.59, lowConfidence: true } },
				},
			]),
			send,
		);
		expect(result.lowConfidence).toBe(true);
	});
});

// SIO-1146: the structured apply outcome is forwarded from applyLearnings' node
// output as hil_learning_applied for the terminal learning card.
describe("pumpEventStream hil_learning_applied", () => {
	const validReport = {
		ticketKey: "DEVOPS-1375",
		incidentId: "jira:DEVOPS-1375",
		incidentCreated: true,
		rootCauseWritten: true,
		factsWritten: 2,
		bindingsConfirmed: 0,
		bindingsInvalidated: 0,
		heuristicsProposed: 0,
		skipped: [{ id: "fact-3", reason: "rejected" }],
		items: [
			{ id: "rc-1", kind: "root-cause", label: "nlb-stale-target-capella-side", status: "applied" },
			{ id: "fact-3", kind: "memory-fact", label: "some fact", status: "rejected" },
		],
	};

	test("forwards a valid hilApplyReport from applyLearnings on_chain_end", async () => {
		const captured: Array<Record<string, unknown>> = [];
		await pumpEventStream(
			fromArray([
				{
					event: "on_chain_end",
					name: "applyLearnings",
					data: { output: { hilApplyReport: validReport } },
				},
			]),
			(event) => {
				captured.push(event);
			},
		);
		const applied = captured.find((e) => e.type === "hil_learning_applied");
		expect(applied).toBeDefined();
		expect((applied?.report as { ticketKey?: string })?.ticketKey).toBe("DEVOPS-1375");
	});

	test("does not emit for a malformed report or a missing output field", async () => {
		const captured: Array<Record<string, unknown>> = [];
		await pumpEventStream(
			fromArray([
				{
					event: "on_chain_end",
					name: "applyLearnings",
					data: { output: { hilApplyReport: { ticketKey: "X" } } },
				},
				{ event: "on_chain_end", name: "applyLearnings", data: { output: {} } },
			]),
			(event) => {
				captured.push(event);
			},
		);
		expect(captured.some((e) => e.type === "hil_learning_applied")).toBe(false);
	});

	test("surfaces applyLearnings partialFailures as partial_failure events", async () => {
		const captured: Array<Record<string, unknown>> = [];
		await pumpEventStream(
			fromArray([
				{
					event: "on_chain_end",
					name: "applyLearnings",
					data: { output: { partialFailures: [{ node: "applyLearnings", reason: "binding-write-failed" }] } },
				},
			]),
			(event) => {
				captured.push(event);
			},
		);
		const failure = captured.find((e) => e.type === "partial_failure");
		expect(failure?.reason).toBe("binding-write-failed");
	});
});

// SIO-1271: the pump filtered streamed tokens by NODE, but four LLM calls share langgraph_node
// "aggregate" -- the aggregator plus gapsJudge and both absenceJudge arms. The judges run after
// the main call, so on run eaebc62b the assembled message stream ended mid-word and continued
// with the absence judge's raw verdict JSON, which a user watching the chat could see.
describe("SIO-1271: only answer-producing roles stream to the browser", () => {
	const streamEvent = (role: string | undefined, node: string, content: string, tags?: string[]) => ({
		event: "on_chat_model_stream",
		...(tags ? { tags } : {}),
		metadata: { langgraph_node: node, ...(role ? { role } : {}) },
		data: { chunk: { content } },
	});

	async function pump(events: Parameters<typeof fromArray>[0]) {
		const captured: Array<Record<string, unknown>> = [];
		const result = await pumpEventStream(fromArray(events), (e) => captured.push(e));
		return { messages: captured.filter((e) => e.type === "message").map((e) => e.content), result };
	}

	test("an absenceJudge token inside the aggregate node produces NO message event", async () => {
		const { messages, result } = await pump([streamEvent("absenceJudge", "aggregate", '{"verdicts":[{"index":0,')]);
		expect(messages).toEqual([]);
		expect(result.responseContent).toBe("");
	});

	test("a gapsJudge token inside the aggregate node produces NO message event", async () => {
		const { messages } = await pump([streamEvent("gapsJudge", "aggregate", '{"keep":[true]}')]);
		expect(messages).toEqual([]);
	});

	test("an aggregator token DOES stream", async () => {
		const { messages } = await pump([streamEvent("aggregator", "aggregate", "# Incident Report")]);
		expect(messages).toEqual(["# Incident Report"]);
	});

	test("a responder token DOES stream", async () => {
		const { messages } = await pump([streamEvent("responder", "responder", "Hello.")]);
		expect(messages).toEqual(["Hello."]);
	});

	// The actual regression: the report body streams, the trailing judge JSON does not.
	test("the report body streams while the trailing judge JSON does not", async () => {
		const { messages, result } = await pump([
			streamEvent("aggregator", "aggregate", "all returning HT"),
			streamEvent("absenceJudge", "aggregate", '```json\n{"verdicts":[{"index":0,"contradictedByData":false}]}'),
		]);
		expect(messages).toEqual(["all returning HT"]);
		expect(result.responseContent).not.toContain("verdicts");
	});

	// Fail-safety: an event with no role at all must still stream, or a propagation change
	// upstream would blank the entire answer rather than merely leaking.
	test("an UNTAGGED aggregate token still streams (no-role fallback)", async () => {
		const { messages } = await pump([streamEvent(undefined, "aggregate", "# Report")]);
		expect(messages).toEqual(["# Report"]);
	});

	test("the no-role fallback still suppresses a judge identified only by tag", async () => {
		const { messages } = await pump([
			streamEvent(undefined, "aggregate", '{"verdicts":[', ["role:absenceJudge", "aggregate"]),
		]);
		expect(messages).toEqual([]);
	});

	test("the role wins over the node name: an aggregator on an unknown node streams", async () => {
		const { messages } = await pump([streamEvent("aggregator", "someFutureNode", "body")]);
		expect(messages).toEqual(["body"]);
	});

	test("a judge role is suppressed even outside the known output nodes", async () => {
		const { messages } = await pump([streamEvent("absenceJudge", "someFutureNode", '{"verdicts":[')]);
		expect(messages).toEqual([]);
	});
});

// SIO-1641: the node allowlist used to be a hand-maintained PIPELINE_NODES set that had
// drifted from graph.ts (selectRunbooks, recordEntities, graphEnrich, awsEstateRouter,
// resolveIdentifiers, enforceCorrelationsAggregate, recordRootCause, recordBindings and
// correlationFetch never emitted, so the live graph triage panel left them and every
// adjacent edge grey). The caller now passes the compiled graph's own node set.
describe("pumpEventStream node allowlist (SIO-1641)", () => {
	test("emits node_start/node_end for every name in the provided set and nothing else", async () => {
		const captured: Array<Record<string, unknown>> = [];
		const send = (event: Record<string, unknown>) => {
			captured.push(event);
		};

		await pumpEventStreamImpl(
			fromArray([
				{ event: "on_chain_start", name: "selectRunbooks" },
				{ event: "on_chain_end", name: "selectRunbooks", data: { output: {} } },
				// A runnable nested inside a node carries its own name; it must not light a node.
				{ event: "on_chain_start", name: "innerStep" },
				{ event: "on_chain_end", name: "innerStep", data: { output: {} } },
				// createReactAgent's inner graph nodes (sub-agent ReAct loop).
				{ event: "on_chain_start", name: "agent" },
				{ event: "on_chain_end", name: "agent", data: { output: {} } },
				{ event: "on_chain_start", name: "recordBindings" },
				{ event: "on_chain_end", name: "recordBindings", data: { output: {} } },
			]),
			send,
			new Set(["selectRunbooks", "recordBindings"]),
		);

		const starts = captured.filter((e) => e.type === "node_start").map((e) => e.nodeId);
		const ends = captured.filter((e) => e.type === "node_end").map((e) => e.nodeId);
		expect(starts).toEqual(["selectRunbooks", "recordBindings"]);
		expect(ends).toEqual(["selectRunbooks", "recordBindings"]);
	});

	test("a node_end with no matching start still emits with duration 0", async () => {
		const captured: Array<Record<string, unknown>> = [];
		await pumpEventStreamImpl(
			fromArray([{ event: "on_chain_end", name: "align", data: { output: {} } }]),
			(e) => {
				captured.push(e);
			},
			new Set(["align"]),
		);
		expect(captured.filter((e) => e.type === "node_end")).toEqual([{ type: "node_end", nodeId: "align", duration: 0 }]);
	});
});

// SIO-1641: parallel Send branches (supervisor fan-out, correlationFetch, per-estate AWS)
// share one node name. The pump used to delete the start time on the FIRST branch's end,
// so every later branch reported duration 0 and the panel showed "queryDataSource 0.0s"
// after a two-minute fan-out. The reducer completes the node on the LAST branch end and
// keeps that end's duration, so the last end must carry first-start-to-last-end.
describe("pumpEventStream parallel-branch durations (SIO-1641)", () => {
	async function* paced(events: LangGraphEvent[], gapMs: number): AsyncIterable<LangGraphEvent> {
		for (const e of events) {
			yield e;
			await Bun.sleep(gapMs);
		}
	}

	test("the last node_end of a fanned-out node carries the wave time, not zero", async () => {
		const captured: Array<Record<string, unknown>> = [];
		await pumpEventStreamImpl(
			paced(
				[
					{ event: "on_chain_start", name: "queryDataSource" },
					{ event: "on_chain_start", name: "queryDataSource" },
					{ event: "on_chain_end", name: "queryDataSource", data: { output: {} } },
					{ event: "on_chain_end", name: "queryDataSource", data: { output: {} } },
				],
				20,
			),
			(e) => {
				captured.push(e);
			},
			new Set(["queryDataSource"]),
		);

		const starts = captured.filter((e) => e.type === "node_start");
		const ends = captured.filter((e) => e.type === "node_end") as Array<{ duration: number }>;
		expect(starts).toHaveLength(2);
		expect(ends).toHaveLength(2);
		// Three 20ms gaps separate the first start from the last end.
		expect(ends[1]?.duration).toBeGreaterThanOrEqual(40);
		// The first end is measured from the first start too (no reset between branches).
		expect(ends[0]?.duration).toBeGreaterThanOrEqual(20);
	});

	test("a node that runs again after fully completing measures from its new start", async () => {
		const captured: Array<Record<string, unknown>> = [];
		await pumpEventStreamImpl(
			paced(
				[
					{ event: "on_chain_start", name: "aggregate" },
					{ event: "on_chain_end", name: "aggregate", data: { output: {} } },
					{ event: "on_chain_start", name: "aggregate" },
					{ event: "on_chain_end", name: "aggregate", data: { output: {} } },
				],
				20,
			),
			(e) => {
				captured.push(e);
			},
			new Set(["aggregate"]),
		);
		const ends = captured.filter((e) => e.type === "node_end") as Array<{ duration: number }>;
		expect(ends).toHaveLength(2);
		// Second run must not include the gap spent before its own start (would be >= 60).
		expect(ends[1]?.duration).toBeLessThan(60);
	});
});

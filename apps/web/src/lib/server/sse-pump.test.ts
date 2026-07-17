// apps/web/src/lib/server/sse-pump.test.ts
// SIO-775: verify pumpEventStream emits datasource_result events with typed
// findings when extractFindings completes.
import { describe, expect, test } from "bun:test";
import { emitIacInterrupt, pumpEventStream } from "./sse-pump.ts";

type LangGraphEvent = {
	event?: string;
	name?: string;
	tags?: string[];
	metadata?: { langgraph_node?: string };
	data?: {
		chunk?: { content?: unknown };
		output?: Record<string, unknown>;
		input?: Record<string, unknown>;
	};
};

async function* fromArray(events: LangGraphEvent[]): AsyncIterable<LangGraphEvent> {
	for (const e of events) yield e;
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

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
		expect(candidates).toHaveLength(2);
		expect(candidates[0]).toMatchObject({ id: "inc-1", hasRootCause: true, via: "vector" });
		expect(candidates[1]).toMatchObject({ id: "inc-2", via: "ticket-mention" });
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

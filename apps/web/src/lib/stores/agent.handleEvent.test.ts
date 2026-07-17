// apps/web/src/lib/stores/agent.handleEvent.test.ts

import { describe, expect, test } from "bun:test";
import type { StreamEvent } from "@devops-agent/shared";
import { applyStreamEvent, initialReducerState } from "./agent-reducer.ts";

describe("applyStreamEvent", () => {
	test("appends message content", () => {
		const next = applyStreamEvent(initialReducerState(), { type: "message", content: "hi " });
		const next2 = applyStreamEvent(next, { type: "message", content: "world" });
		expect(next2.currentContent).toBe("hi world");
	});

	// SIO-1141: message_final REPLACES the accumulated stream (the aggregate tokens were
	// streamed pre-cap; the corrected body carries the gate confidence + all rewrites).
	test("message_final replaces accumulated streamed content", () => {
		let state = applyStreamEvent(initialReducerState(), {
			type: "message",
			content: "# Report\n\nConfidence: 0.81",
		});
		expect(state.currentContent).toContain("0.81");
		state = applyStreamEvent(state, {
			type: "message_final",
			content: "# Report\n\nConfidence: 0.59",
		});
		expect(state.currentContent).toBe("# Report\n\nConfidence: 0.59");
		expect(state.currentContent).not.toContain("0.81");
	});

	// SIO-876: live pipeline-watch ticker accumulates status transitions.
	test("accumulates iac_pipeline_progress lines", () => {
		let state = initialReducerState();
		state = applyStreamEvent(state, { type: "iac_pipeline_progress", pipelineId: 355, status: "running" });
		state = applyStreamEvent(state, { type: "iac_pipeline_progress", pipelineId: 355, status: "success" });
		expect(state.iacPipelineProgress).toEqual(["Pipeline #355: running", "Pipeline #355: success"]);
	});

	test("iac_pipeline_progress handles a null pipelineId", () => {
		const next = applyStreamEvent(initialReducerState(), {
			type: "iac_pipeline_progress",
			pipelineId: null,
			status: "pending",
		});
		expect(next.iacPipelineProgress).toEqual(["Pipeline: pending"]);
	});

	// SIO-982: the GitOps MR flow has no result event (it ends with a plain message + done), so the
	// done handler snapshots the live pipeline progress into iacPipelineLog -- the durable field the
	// UI renders as a persistent collapsed "Pipeline log" panel after the turn (mirrors fleet's
	// progressLog, SIO-928). The live iacPipelineProgress is only shown while streaming.
	test("done snapshots iacPipelineProgress into iacPipelineLog (GitOps MR persistence)", () => {
		let state = initialReducerState();
		state = applyStreamEvent(state, { type: "iac_pipeline_progress", pipelineId: 9, status: "created" });
		state = applyStreamEvent(state, { type: "iac_pipeline_progress", pipelineId: 9, status: "running" });
		state = applyStreamEvent(state, { type: "done", threadId: "t-1", responseTime: 100 });
		expect(state.iacPipelineLog).toEqual(["Pipeline #9: created", "Pipeline #9: running"]);
	});

	test("done with no pipeline progress leaves iacPipelineLog empty", () => {
		const next = applyStreamEvent(initialReducerState(), { type: "done", threadId: "t-1", responseTime: 100 });
		expect(next.iacPipelineLog ?? []).toEqual([]);
	});

	// SIO-982: fleet captures its OWN progress into fleetUpgradeResult.progressLog (SIO-928); the
	// GitOps snapshot must NOT also fire for a fleet turn (no double-capture / independent paths).
	test("done does NOT snapshot iacPipelineLog when a fleet result already captured it", () => {
		let state = initialReducerState();
		state = applyStreamEvent(state, { type: "iac_pipeline_progress", pipelineId: 9, status: "running" });
		state = applyStreamEvent(state, {
			type: "fleet_upgrade_apply_result",
			status: "applied",
			acked: 4,
			failedSilent: 0,
		});
		state = applyStreamEvent(state, { type: "done", threadId: "t-1", responseTime: 100 });
		// fleet keeps its own progressLog; the GitOps field stays empty so the panel isn't double-rendered.
		expect(state.fleetUpgradeResult?.progressLog).toEqual(["Pipeline #9: running"]);
		expect(state.iacPipelineLog ?? []).toEqual([]);
	});

	test("tracks node_start and node_end transitions", () => {
		let state = initialReducerState();
		state = applyStreamEvent(state, { type: "node_start", nodeId: "classify" });
		expect(state.activeNodes.has("classify")).toBe(true);
		state = applyStreamEvent(state, { type: "node_end", nodeId: "classify", duration: 42 });
		expect(state.activeNodes.has("classify")).toBe(false);
		expect(state.completedNodes.get("classify")).toEqual({ duration: 42 });
	});

	test("captures suggestions", () => {
		const next = applyStreamEvent(initialReducerState(), {
			type: "suggestions",
			suggestions: ["a", "b"],
		});
		expect(next.lastSuggestions).toEqual(["a", "b"]);
	});

	test("captures done event metadata", () => {
		const next = applyStreamEvent(initialReducerState(), {
			type: "done",
			threadId: "t-1",
			runId: "r-1",
			responseTime: 123,
			toolsUsed: ["elastic_search"],
		});
		expect(next.threadId).toBe("t-1");
		expect(next.lastRunId).toBe("r-1");
		expect(next.lastResponseTime).toBe(123);
		expect(next.lastToolsUsed).toEqual(["elastic_search"]);
	});

	test("captures the IaC turn outcome from done (SIO-930)", () => {
		const next = applyStreamEvent(initialReducerState(), {
			type: "done",
			threadId: "t-1",
			responseTime: 100,
			outcome: "rejected",
		});
		expect(next.lastOutcome).toBe("rejected");
	});

	test("defaults outcome to completed when absent (SIO-930)", () => {
		const next = applyStreamEvent(initialReducerState(), { type: "done", threadId: "t-1", responseTime: 100 });
		expect(next.lastOutcome).toBe("completed");
	});

	test("appends error message to current content", () => {
		const next = applyStreamEvent(initialReducerState(), {
			type: "error",
			message: "boom",
		});
		expect(next.currentContent).toContain("boom");
	});

	// SIO-1110: an errored stream must not keep the initial "completed" outcome
	// (the chip rendered green over a dead run).
	test("error event sets lastOutcome to error", () => {
		const next = applyStreamEvent(initialReducerState(), {
			type: "error",
			message: "The operation was aborted due to timeout",
		});
		expect(next.lastOutcome).toBe("error");
		expect(next.currentContent).toContain("[Error: The operation was aborted due to timeout]");
	});

	test("records pending_actions", () => {
		const next = applyStreamEvent(initialReducerState(), {
			type: "pending_actions",
			actions: [
				{
					id: "a-1",
					tool: "notify-slack",
					params: {},
					reason: "Notify on-call about the elevated error rate",
				},
			],
		});
		expect(next.pendingActions).toHaveLength(1);
		expect(next.pendingActions[0]?.id).toBe("a-1");
	});

	test("records datasource_progress with immutable map copy", () => {
		const initial = initialReducerState();
		const next = applyStreamEvent(initial, {
			type: "datasource_progress",
			dataSourceId: "elastic",
			status: "running",
			message: "querying",
		});
		expect(next.dataSourceProgress.get("elastic")).toEqual({ status: "running", message: "querying" });
		expect(initial.dataSourceProgress.size).toBe(0);
	});

	// SIO-775: datasource_result carries typed findings for the *FindingsCard
	// components. Stored in a separate dataSourceFindings map keyed by bare id.
	test("records datasource_result with typed kafkaFindings", () => {
		const initial = initialReducerState();
		const next = applyStreamEvent(initial, {
			type: "datasource_result",
			dataSourceId: "kafka",
			status: "success",
			duration: 1234,
			kafkaFindings: {
				consumerGroups: [{ id: "pim-sink", state: "STABLE", totalLag: 42 }],
				dlqTopics: [{ name: "orders.dlq", totalMessages: 17, recentDelta: 3 }],
			},
		});
		const entry = next.dataSourceFindings.get("kafka");
		expect(entry?.status).toBe("success");
		expect(entry?.duration).toBe(1234);
		expect(entry?.kafkaFindings?.consumerGroups?.[0]?.id).toBe("pim-sink");
		expect(initial.dataSourceFindings.size).toBe(0);
	});

	test("records datasource_result error without findings", () => {
		const next = applyStreamEvent(initialReducerState(), {
			type: "datasource_result",
			dataSourceId: "kafka",
			status: "error",
			error: "MCP error -32010",
		});
		const entry = next.dataSourceFindings.get("kafka");
		expect(entry?.status).toBe("error");
		expect(entry?.error).toBe("MCP error -32010");
		expect(entry?.kafkaFindings).toBeUndefined();
	});

	test("does not mutate input state when handling node_start", () => {
		const before = initialReducerState();
		const sizeBefore = before.activeNodes.size;
		applyStreamEvent(before, { type: "node_start", nodeId: "x" });
		expect(before.activeNodes.size).toBe(sizeBefore);
	});

	test("captures run_id event so feedback can submit before done", () => {
		const next = applyStreamEvent(initialReducerState(), { type: "run_id", runId: "r-early" });
		expect(next.lastRunId).toBe("r-early");
	});

	test("passes through attachment_warnings without throwing", () => {
		const next = applyStreamEvent(initialReducerState(), {
			type: "attachment_warnings",
			warnings: ["truncated-pdf"],
		});
		expect(next.currentContent).toBe("");
	});

	test("returns state unchanged for unknown event types", () => {
		const before = initialReducerState();
		const after = applyStreamEvent(before, { type: "future_event_x" } as unknown as StreamEvent);
		expect(after).toBe(before);
	});

	// SIO-751: topic-shift events drive the HITL banner. topic_shift_prompt sets
	// the banner state; topic_shift_resolved clears it before the resumed graph
	// pushes new node_start / message events through the reducer.
	test("topic_shift_prompt populates the banner state", () => {
		const next = applyStreamEvent(initialReducerState(), {
			type: "topic_shift_prompt",
			threadId: "t-1",
			oldFocusSummary: "high investigation of styles-v3",
			newFocusSummary: "low investigation of jira-mars",
			oldServices: ["styles-v3"],
			newServices: ["jira-mars"],
			message: "Continue or fresh?",
		});
		expect(next.topicShiftPrompt).not.toBeNull();
		expect(next.topicShiftPrompt?.threadId).toBe("t-1");
		expect(next.topicShiftPrompt?.oldServices).toEqual(["styles-v3"]);
		expect(next.topicShiftPrompt?.newServices).toEqual(["jira-mars"]);
		expect(next.topicShiftPrompt?.message).toBe("Continue or fresh?");
	});

	test("topic_shift_resolved clears the banner state", () => {
		const promoted = applyStreamEvent(initialReducerState(), {
			type: "topic_shift_prompt",
			threadId: "t-1",
			oldFocusSummary: "x",
			newFocusSummary: "y",
			oldServices: [],
			newServices: [],
			message: "msg",
		});
		expect(promoted.topicShiftPrompt).not.toBeNull();
		const cleared = applyStreamEvent(promoted, { type: "topic_shift_resolved" });
		expect(cleared.topicShiftPrompt).toBeNull();
	});

	// SIO-1126: the HIL learning gates drive the match/review cards. The two are
	// mutually exclusive (one gate at a time); hil_learning_resolved clears both.
	test("hil_learning_match populates the match card and clears any review card", () => {
		let state = applyStreamEvent(initialReducerState(), {
			type: "hil_learning_review",
			threadId: "t-1",
			ticketKey: "DEVOPS-1355",
			proposal: { ticketKey: "DEVOPS-1355", rootCause: null, bindings: [], heuristics: [], memoryFacts: [] },
			alreadyLearned: false,
			message: "review",
		});
		expect(state.hilLearningReview).not.toBeNull();
		state = applyStreamEvent(state, {
			type: "hil_learning_match",
			threadId: "t-1",
			ticketKey: "DEVOPS-1355",
			ticketSummary: "summary",
			candidates: [{ id: "inc-1", summary: "s", severity: "high", distance: 0.1, hasRootCause: false, via: "vector" }],
			message: "pick",
		});
		expect(state.hilLearningMatch?.candidates).toHaveLength(1);
		expect(state.hilLearningMatch?.ticketKey).toBe("DEVOPS-1355");
		expect(state.hilLearningReview).toBeNull();
		expect(state.threadId).toBe("t-1");
	});

	test("hil_learning_resolved clears both learning cards", () => {
		const withMatch = applyStreamEvent(initialReducerState(), {
			type: "hil_learning_match",
			threadId: "t-1",
			ticketKey: "DEVOPS-1355",
			ticketSummary: "summary",
			candidates: [],
			message: "pick",
		});
		expect(withMatch.hilLearningMatch).not.toBeNull();
		const cleared = applyStreamEvent(withMatch, { type: "hil_learning_resolved" });
		expect(cleared.hilLearningMatch).toBeNull();
		expect(cleared.hilLearningReview).toBeNull();
	});

	// SIO-1146: the structured apply outcome becomes the terminal card; it clears
	// the gate cards, survives done, and a fresh learning gate replaces it.
	const applyReport = {
		ticketKey: "DEVOPS-1355",
		incidentId: "inc-1",
		incidentCreated: false,
		rootCauseWritten: true,
		factsWritten: 1,
		bindingsConfirmed: 0,
		bindingsInvalidated: 0,
		heuristicsProposed: 0,
		skipped: [],
		items: [{ id: "rc-1", kind: "root-cause" as const, label: "cause-class", status: "applied" as const }],
	};

	test("hil_learning_applied sets the outcome card and clears the review card", () => {
		let state = applyStreamEvent(initialReducerState(), {
			type: "hil_learning_review",
			threadId: "t-1",
			ticketKey: "DEVOPS-1355",
			proposal: { ticketKey: "DEVOPS-1355", rootCause: null, bindings: [], heuristics: [], memoryFacts: [] },
			alreadyLearned: false,
			message: "review",
		});
		state = applyStreamEvent(state, { type: "hil_learning_applied", report: applyReport });
		expect(state.hilLearningOutcome?.ticketKey).toBe("DEVOPS-1355");
		expect(state.hilLearningReview).toBeNull();
		expect(state.hilLearningMatch).toBeNull();
	});

	test("the outcome card survives done but a fresh learning gate clears it", () => {
		let state = applyStreamEvent(initialReducerState(), { type: "hil_learning_applied", report: applyReport });
		state = applyStreamEvent(state, { type: "done", threadId: "t-1", responseTime: 100 });
		expect(state.hilLearningOutcome).not.toBeNull();
		state = applyStreamEvent(state, { type: "hil_learning_resolved" });
		expect(state.hilLearningOutcome).not.toBeNull(); // resolved fires at resume-start, pre-apply
		state = applyStreamEvent(state, {
			type: "hil_learning_match",
			threadId: "t-2",
			ticketKey: "DEVOPS-1400",
			ticketSummary: "summary",
			candidates: [],
			message: "pick",
		});
		expect(state.hilLearningOutcome).toBeNull();
	});

	// SIO-922: the fleet-upgrade gate was emitted by the backend but dropped by the UI; these
	// pin the report -> choice -> result chain that renders the card and clears it on apply.
	test("fleet_upgrade_preview_report populates the preview and clears any prior result", () => {
		let state = initialReducerState();
		state = applyStreamEvent(state, {
			type: "fleet_upgrade_apply_result",
			status: "applied",
			acked: 1,
		});
		expect(state.fleetUpgradeResult).not.toBeNull();
		state = applyStreamEvent(state, {
			type: "fleet_upgrade_preview_report",
			deployment: "eu-b2b",
			targetVersion: "9.4.2",
			resolvedCount: 232,
			versionAvailable: true,
			rolloutSeconds: 600,
			crosstab: { upgradeable: 4, notUpgradeable: 228, byReason: [{ reason: "wolfi", count: 228 }] },
		});
		expect(state.fleetUpgradePreview?.crosstab.upgradeable).toBe(4);
		expect(state.fleetUpgradeResult).toBeNull(); // a fresh preview clears the prior outcome
	});

	test("fleet_upgrade_choice sets the gate prompt; apply_result clears it", () => {
		let state = initialReducerState();
		state = applyStreamEvent(state, {
			type: "fleet_upgrade_choice",
			threadId: "t-fleet",
			deployment: "eu-b2b",
			targetVersion: "9.4.2",
			resolvedCount: 232,
			upgradeableCount: 4,
			notUpgradeableCount: 228,
			rolloutSeconds: 600,
			byReason: [{ reason: "wolfi", count: 228 }],
			message: "Approve?",
		});
		expect(state.fleetUpgradeChoice?.upgradeableCount).toBe(4);
		expect(state.threadId).toBe("t-fleet");
		state = applyStreamEvent(state, {
			type: "fleet_upgrade_apply_result",
			status: "applied",
			acked: 4,
			failedSilent: 0,
		});
		expect(state.fleetUpgradeChoice).toBeNull(); // the gate clears once the apply lands
		expect(state.fleetUpgradeResult?.status).toBe("applied");
	});

	// SIO-971: prior-upgrade recall flows through the choice event onto the gate card.
	test("fleet_upgrade_choice carries priorUpgrades onto the gate prompt", () => {
		let state = initialReducerState();
		state = applyStreamEvent(state, {
			type: "fleet_upgrade_choice",
			threadId: "t-fleet",
			deployment: "us-cld",
			targetVersion: "9.4.2",
			resolvedCount: 232,
			upgradeableCount: 4,
			notUpgradeableCount: 228,
			rolloutSeconds: 600,
			byReason: [{ reason: "wolfi", count: 228 }],
			priorUpgrades: "- Fleet agents on us-cld upgraded to 9.3.0. [9.3.0 applied]",
			message: "Approve?",
		});
		expect(state.fleetUpgradeChoice?.priorUpgrades).toContain("upgraded to 9.3.0");
	});

	// SIO-935: the version partition flows through both events into state so the card can render
	// "already on target / will upgrade / not Fleet-upgradeable". (The two tests above cover the
	// back-compat path where versionCrosstab is absent and stays undefined.)
	test("versionCrosstab flows through preview_report and choice into state", () => {
		const vc = { alreadyOnTarget: 196, outdated: 611, versionUnknown: 0, upgradeableOutdated: 6 };
		let state = initialReducerState();
		state = applyStreamEvent(state, {
			type: "fleet_upgrade_preview_report",
			deployment: "us-cld",
			targetVersion: "9.4.2",
			resolvedCount: 807,
			versionAvailable: true,
			rolloutSeconds: 3600,
			crosstab: { upgradeable: 6, notUpgradeable: 801, byReason: [{ reason: "unknown", count: 601 }] },
			versionCrosstab: vc,
		});
		expect(state.fleetUpgradePreview?.versionCrosstab?.alreadyOnTarget).toBe(196);
		expect(state.fleetUpgradePreview?.versionCrosstab?.upgradeableOutdated).toBe(6);

		state = applyStreamEvent(state, {
			type: "fleet_upgrade_choice",
			threadId: "t-fleet",
			deployment: "us-cld",
			targetVersion: "9.4.2",
			resolvedCount: 807,
			upgradeableCount: 6,
			notUpgradeableCount: 801,
			rolloutSeconds: 3600,
			byReason: [{ reason: "unknown", count: 601 }],
			versionCrosstab: vc,
			message: "Approve?",
		});
		expect(state.fleetUpgradeChoice?.versionCrosstab?.alreadyOnTarget).toBe(196);
		expect(state.fleetUpgradeChoice?.versionCrosstab?.upgradeableOutdated).toBe(6);
	});

	// SIO-928: the apply result snapshots the live progress lines onto the result row so the
	// timeline persists as a collapsed log AFTER the `done` handler clears iacPipelineProgress.
	test("fleet_upgrade_apply_result captures the live progress lines as progressLog", () => {
		let state = initialReducerState();
		state = applyStreamEvent(state, { type: "iac_pipeline_progress", pipelineId: 2606400810, status: "created" });
		state = applyStreamEvent(state, {
			type: "iac_pipeline_progress",
			pipelineId: 2606400810,
			status: "fleet apply: started -- 1608 agent(s) -> 9.4.2, expected ~60 min",
		});
		state = applyStreamEvent(state, { type: "fleet_upgrade_apply_result", status: "applied", acked: 1608 });

		expect(state.fleetUpgradeResult?.progressLog).toEqual([
			"Pipeline #2606400810: created",
			"Pipeline #2606400810: fleet apply: started -- 1608 agent(s) -> 9.4.2, expected ~60 min",
		]);
	});

	// The captured log must outlive the live ticker: the store's `done`/resume handlers reset
	// iacPipelineProgress to [], but the result row (and its progressLog) is not touched.
	test("progressLog on the result survives a later done that clears the live ticker", () => {
		let state = initialReducerState();
		state = applyStreamEvent(state, { type: "iac_pipeline_progress", pipelineId: 42, status: "running" });
		state = applyStreamEvent(state, { type: "fleet_upgrade_apply_result", status: "applied" });
		// The reducer itself does not clear iacPipelineProgress on `done` (the store does), but the
		// result row must be independent of the live array regardless -- assert the snapshot is a copy.
		state = applyStreamEvent(state, { type: "iac_pipeline_progress", pipelineId: 42, status: "success" });
		expect(state.fleetUpgradeResult?.progressLog).toEqual(["Pipeline #42: running"]); // not mutated by the later line
	});

	test("fleet_upgrade_apply_result with no prior progress omits progressLog", () => {
		const state = applyStreamEvent(initialReducerState(), { type: "fleet_upgrade_apply_result", status: "applied" });
		expect(state.fleetUpgradeResult?.progressLog).toBeUndefined();
	});
});

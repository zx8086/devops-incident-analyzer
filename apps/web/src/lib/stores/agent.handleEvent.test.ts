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

	test("appends error message to current content", () => {
		const next = applyStreamEvent(initialReducerState(), {
			type: "error",
			message: "boom",
		});
		expect(next.currentContent).toContain("boom");
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
});

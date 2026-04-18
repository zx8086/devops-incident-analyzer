// apps/web/src/lib/stores/agent.handleEvent.test.ts
import { describe, expect, test } from "bun:test";
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
});

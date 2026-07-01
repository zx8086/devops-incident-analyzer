// agent/src/sub-agent-loop-guard.test.ts

import { describe, expect, test } from "bun:test";
import {
	createLoopGuardState,
	isGuardedTool,
	isUnproductiveResult,
	recordResult,
	shouldShortCircuit,
	toolCallSignature,
} from "./sub-agent-loop-guard.ts";

const EMPTY_SEARCH = "Total results: 0, showing 0 from position 0"; // the 43-byte empty result

describe("SIO-1029: loop guard result classification", () => {
	test("recognizes the empty elasticsearch_search string as unproductive", () => {
		expect(isUnproductiveResult(EMPTY_SEARCH)).toBe(true);
	});

	test("empty array and empty content are unproductive", () => {
		expect(isUnproductiveResult("[]")).toBe(true);
		expect(isUnproductiveResult("")).toBe(true);
	});

	test("a real result with hits is productive", () => {
		expect(isUnproductiveResult('[{"_source":{"message":"boom"}}]')).toBe(false);
		expect(isUnproductiveResult("Total results: 5, showing 5 from position 0")).toBe(false);
	});

	test("only elasticsearch_search is guarded", () => {
		expect(isGuardedTool("elasticsearch_search")).toBe(true);
		expect(isGuardedTool("kafka_list_topics")).toBe(false);
	});
});

describe("SIO-1029: loop guard short-circuit decisions", () => {
	test("trips after two consecutive empty searches", () => {
		const state = createLoopGuardState();
		const sig1 = toolCallSignature("elasticsearch_search", { index: "logs-*", q: "a" });
		const sig2 = toolCallSignature("elasticsearch_search", { index: "traces-*", q: "b" });
		const sig3 = toolCallSignature("elasticsearch_search", { index: "metrics-*", q: "c" });

		expect(shouldShortCircuit(state, "elasticsearch_search", sig1)).toBe(false);
		recordResult(state, "elasticsearch_search", sig1, EMPTY_SEARCH);

		expect(shouldShortCircuit(state, "elasticsearch_search", sig2)).toBe(false);
		recordResult(state, "elasticsearch_search", sig2, EMPTY_SEARCH);

		// third distinct call: budget of 2 consecutive empties is now exhausted
		expect(shouldShortCircuit(state, "elasticsearch_search", sig3)).toBe(true);
	});

	test("a productive result resets the consecutive-empty streak", () => {
		const state = createLoopGuardState();
		const sigA = toolCallSignature("elasticsearch_search", { q: "a" });
		const sigB = toolCallSignature("elasticsearch_search", { q: "b" });
		const sigC = toolCallSignature("elasticsearch_search", { q: "c" });
		const sigD = toolCallSignature("elasticsearch_search", { q: "d" });

		recordResult(state, "elasticsearch_search", sigA, EMPTY_SEARCH);
		recordResult(state, "elasticsearch_search", sigB, '[{"_source":{"x":1}}]'); // productive -> reset
		expect(shouldShortCircuit(state, "elasticsearch_search", sigC)).toBe(false);
		recordResult(state, "elasticsearch_search", sigC, EMPTY_SEARCH);
		expect(shouldShortCircuit(state, "elasticsearch_search", sigD)).toBe(false);
	});

	test("exact-duplicate call is short-circuited immediately even with productive results", () => {
		const state = createLoopGuardState();
		const sig = toolCallSignature("elasticsearch_search", { index: "logs-*", q: "same" });
		recordResult(state, "elasticsearch_search", sig, '[{"_source":{"x":1}}]');
		// identical (tool, args) again -> loop, short-circuit
		expect(shouldShortCircuit(state, "elasticsearch_search", sig)).toBe(true);
	});

	test("signature is stable across key ordering", () => {
		expect(toolCallSignature("elasticsearch_search", { a: 1, b: 2 })).toBe(
			toolCallSignature("elasticsearch_search", { b: 2, a: 1 }),
		);
	});

	test("non-guarded tools never short-circuit", () => {
		const state = createLoopGuardState();
		const sig = toolCallSignature("kafka_list_topics", {});
		recordResult(state, "kafka_list_topics", sig, EMPTY_SEARCH);
		recordResult(state, "kafka_list_topics", sig, EMPTY_SEARCH);
		expect(shouldShortCircuit(state, "kafka_list_topics", sig)).toBe(false);
	});
});

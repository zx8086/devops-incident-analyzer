// packages/agent/src/state-partial-failures.test.ts
//
// SIO-739: partialFailures append reducer + default.

import { describe, expect, test } from "bun:test";
import { AgentState, type AgentStateType } from "./state.ts";

// LangGraph BinaryOperatorAggregate exposes `operator` (the reducer) and
// `initialValueFactory` (the default factory) — not `reducer`/`default`.
type ChannelSpec = {
	operator?: (prev: unknown, next: unknown) => unknown;
	initialValueFactory?: () => unknown;
};

describe("AgentState.partialFailures", () => {
	test("default is empty array", () => {
		const spec = AgentState.spec as Record<string, ChannelSpec>;
		const fieldSpec = spec.partialFailures;
		expect(fieldSpec).toBeDefined();
		expect(fieldSpec?.initialValueFactory?.()).toEqual([]);
	});

	test("reducer appends new entries", () => {
		const spec = AgentState.spec as Record<string, ChannelSpec>;
		const reducer = spec.partialFailures?.operator;
		expect(reducer).toBeDefined();
		const result = reducer?.(
			[{ node: "proposeMitigation", reason: "timeout" }],
			[{ node: "followUp", reason: "timeout" }],
		);
		expect(result).toEqual([
			{ node: "proposeMitigation", reason: "timeout" },
			{ node: "followUp", reason: "timeout" },
		]);
	});

	test("empty next does not reset accumulated entries (monotonic, unlike dataSourceResults)", () => {
		const spec = AgentState.spec as Record<string, ChannelSpec>;
		const reducer = spec.partialFailures?.operator;
		expect(reducer).toBeDefined();
		const existing = [{ node: "proposeMitigation", reason: "timeout" }];
		const result = reducer?.(existing, []);
		expect(result).toEqual(existing);
	});

	test("AgentStateType compiles with partialFailures field", () => {
		// Type-level assertion: this assignment must compile under strict mode.
		const sample: Pick<AgentStateType, "partialFailures"> = {
			partialFailures: [{ node: "proposeMitigation", reason: "timeout" }],
		};
		expect(sample.partialFailures).toHaveLength(1);
	});
});

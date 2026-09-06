// agent/src/pi-fleet/state.test.ts
// SIO-1655 (Phase 2c): the reducers. `replies` accumulates so a partial gather
// is still reportable; `targets` replaces because one round of asking per turn
// means a second write is a correction, not an append.
import { describe, expect, test } from "bun:test";
import { PiFleetState, type SpokeReply } from "./state.ts";

// LangGraph exposes a channel's reducer as `operator` and its default as
// `initialValueFactory`.
function reduce<K extends keyof typeof PiFleetState.spec>(key: K, prev: unknown, next: unknown): unknown {
	const channel = PiFleetState.spec[key] as unknown as {
		operator: (a: unknown, b: unknown) => unknown;
		initialValueFactory?: () => unknown;
	};
	const base = prev === undefined ? channel.initialValueFactory?.() : prev;
	return channel.operator(base, next);
}

const answered: SpokeReply = { estate: "eu-oit-prd", target: "eu-oit-prd", msgId: "m1", status: "answered", text: "ok" };
const queued: SpokeReply = { estate: "eu-b2b-prd", target: "ops", msgId: "m2", status: "queued" };

describe("SIO-1655 PiFleetState", () => {
	test("replies accumulate across the turn", () => {
		const first = reduce("replies", [], [answered]) as SpokeReply[];
		const second = reduce("replies", first, [queued]) as SpokeReply[];
		expect(second.map((r) => r.estate)).toEqual(["eu-oit-prd", "eu-b2b-prd"]);
	});

	test("a partial gather keeps the estates that did answer", () => {
		const replies = reduce("replies", [answered], [queued]) as SpokeReply[];
		expect(replies.filter((r) => r.status === "answered")).toHaveLength(1);
		expect(replies.filter((r) => r.status !== "answered")).toHaveLength(1);
	});

	test("targets replace rather than append (one asking round per turn)", () => {
		const first = reduce("targets", [], ["eu-oit-prd"]) as string[];
		const second = reduce("targets", first, ["eu-b2b-prd"]) as string[];
		expect(second).toEqual(["eu-b2b-prd"]);
	});

	test("targets and replies default to empty, question to empty string", () => {
		expect(reduce("targets", undefined, undefined)).toEqual([]);
		expect(reduce("question", "", "why is checkout slow")).toBe("why is checkout slow");
	});

	test("registered flips both ways so teardown knows what is owed", () => {
		expect(reduce("registered", false, true)).toBe(true);
		expect(reduce("registered", true, false)).toBe(false);
	});
});

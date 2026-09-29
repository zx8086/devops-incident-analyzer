// agent/src/learning-gate.test.ts

// SIO-1889: the Jev learning gate. Pure verdict rule, the head-plus-tail
// projection, and the seam's three outcomes with an injected ask.
import { beforeEach, describe, expect, mock, test } from "bun:test";

const rows: Array<Record<string, unknown>> = [];
mock.module("./decision-recorder.ts", () => ({
	recordDecision: (entry: Record<string, unknown>) => {
		rows.push(entry);
	},
}));

import {
	gateLearning,
	isLearningJevGateEnabled,
	judgeLearning,
	LEARNING_QUESTIONS,
	PROJECTION_FIELD_CAP,
	PROJECTION_HEAD,
	PROJECTION_TAIL,
	projectEvents,
	transcriptToEvents,
} from "./learning-gate.ts";

beforeEach(() => {
	rows.length = 0;
});

describe("isLearningJevGateEnabled", () => {
	test("on unless explicitly false or 0", () => {
		expect(isLearningJevGateEnabled({})).toBe(true);
		expect(isLearningJevGateEnabled({ LEARNING_JEV_GATE_ENABLED: "true" })).toBe(true);
		expect(isLearningJevGateEnabled({ LEARNING_JEV_GATE_ENABLED: "false" })).toBe(false);
		expect(isLearningJevGateEnabled({ LEARNING_JEV_GATE_ENABLED: "0" })).toBe(false);
	});
});

describe("judgeLearning (beacon rule)", () => {
	test("task_success below the floor fails even when the mean clears the bar", () => {
		const v = judgeLearning({ task_success: 0.4, reusable_correction: 1, evidence_supported: 1 });
		expect(v.qualifies).toBe(false);
		expect(v.reason).toBe("task_success");
		expect(v.score).toBeCloseTo(0.8);
	});

	test("task_success at the floor then needs the mean to clear 0.6", () => {
		expect(judgeLearning({ task_success: 0.5, reusable_correction: 0.9, evidence_supported: 0.9 }).qualifies).toBe(true);
		const low = judgeLearning({ task_success: 0.5, reusable_correction: 0.5, evidence_supported: 0.6 });
		expect(low.qualifies).toBe(false);
		expect(low.reason).toBe("reusable_correction");
	});

	test("names the weakest of the other two questions when the mean fails", () => {
		const v = judgeLearning({ task_success: 0.9, reusable_correction: 0.6, evidence_supported: 0.2 });
		expect(v.qualifies).toBe(false);
		expect(v.reason).toBe("evidence_supported");
	});

	test("thumbs replaces task_success in both directions", () => {
		const up = judgeLearning({ task_success: 0.1, reusable_correction: 0.9, evidence_supported: 0.9 }, 1);
		expect(up.taskSuccess).toBe(1);
		expect(up.qualifies).toBe(true);
		const down = judgeLearning({ task_success: 0.99, reusable_correction: 1, evidence_supported: 1 }, 0);
		expect(down.taskSuccess).toBe(0);
		expect(down.qualifies).toBe(false);
		expect(down.reason).toBe("task_success");
	});
});

describe("projectEvents", () => {
	test("keeps everything up to head plus tail", () => {
		const events = Array.from({ length: PROJECTION_HEAD + PROJECTION_TAIL }, (_, i) => `e${i}`);
		expect(projectEvents(events)).toEqual(events);
	});

	test("windows a long session to head, an omission marker, and tail", () => {
		const events = Array.from({ length: 100 }, (_, i) => `e${i}`);
		const out = projectEvents(events);
		expect(out).toHaveLength(PROJECTION_HEAD + 1 + PROJECTION_TAIL);
		expect(out[0]).toBe("e0");
		expect(out[PROJECTION_HEAD]).toBe("[... 20 events omitted ...]");
		expect(out.at(-1)).toBe("e99");
	});

	test("caps each field and redacts PII before anything leaves the box", () => {
		const long = "x".repeat(PROJECTION_FIELD_CAP + 50);
		const out = projectEvents([long, "call 555-123-4567 about ssn 123-45-6789"]);
		expect(out[0]).toHaveLength(PROJECTION_FIELD_CAP);
		expect(out[1]).not.toContain("123-45-6789");
	});

	test("transcriptToEvents splits at paragraphs, else lines", () => {
		expect(transcriptToEvents("User: a\n\nAssistant: b")).toEqual(["User: a", "Assistant: b"]);
		expect(transcriptToEvents("one\ntwo\n")).toEqual(["one", "two"]);
	});
});

describe("gateLearning", () => {
	const answers = (p: Record<string, number>) => ({
		model: "jev-1.13.0",
		answers: Object.fromEntries(Object.entries(p).map(([k, v]) => [k, { type: "noul" as const, noul: v }])),
		usage: { input_tokens: 321, output_tokens: 3 },
	});

	test("asks the three questions over the projected session and applies the verdict", async () => {
		let seen: { state: unknown; questions: unknown } | undefined;
		const out = await gateLearning(
			{ events: ["User: fix the lag", "Assistant: done, it was the ILM policy"], requestId: "r1" },
			{
				apiKey: "k",
				ask: async (o) => {
					seen = { state: o.state, questions: o.questions };
					return answers({ task_success: 0.9, reusable_correction: 0.8, evidence_supported: 0.7 });
				},
			},
		);
		expect(out.outcome).toBe("applied");
		if (out.outcome !== "applied") throw new Error("unreachable");
		expect(out.verdict.qualifies).toBe(true);
		expect(out.model).toBe("jev-1.13.0");
		expect(seen?.questions).toBe(LEARNING_QUESTIONS);
		const state = seen?.state as { session: string[] } | undefined;
		expect(state?.session).toEqual([
			"User: fix the lag",
			"Assistant: done, it was the ILM policy",
		]);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ seam: "learning-gate", outcome: "applied", note: "qualifies", requestId: "r1" });
		expect(rows[0]?.topScore).toBeCloseTo(0.8);
	});

	test("a below-floor task_success is applied and does not qualify", async () => {
		const out = await gateLearning(
			{ events: ["x"] },
			{ apiKey: "k", ask: async () => answers({ task_success: 0.2, reusable_correction: 1, evidence_supported: 1 }) },
		);
		expect(out.outcome).toBe("applied");
		if (out.outcome === "applied") expect(out.verdict.qualifies).toBe(false);
		expect(rows[0]).toMatchObject({ outcome: "applied", note: "task_success" });
	});

	test("skips without a key, and when the flag is off, recording why", async () => {
		const noKey = await gateLearning({ events: ["x"] }, { env: { NODE_ENV: "test" } });
		expect(noKey).toEqual({ outcome: "skipped", reason: "no-key" });
		const off = await gateLearning({ events: ["x"] }, { env: { LEARNING_JEV_GATE_ENABLED: "false" }, apiKey: "k" });
		expect(off).toEqual({ outcome: "skipped", reason: "disabled" });
		expect(rows.map((r) => r.note)).toEqual(["no-key", "disabled"]);
	});

	test("a throw is a failed row with status only, never the upstream text", async () => {
		const out = await gateLearning(
			{ events: ["x"] },
			{
				apiKey: "k",
				ask: async () => {
					throw new Error("TypeSafe request failed with status 503");
				},
			},
		);
		expect(out).toEqual({ outcome: "failed", reason: "TypeSafe request failed with status 503" });
		const other = await gateLearning(
			{ events: ["x"] },
			{
				apiKey: "k",
				ask: async () => {
					throw new Error("body echoed: user ssn 123-45-6789");
				},
			},
		);
		expect(other).toEqual({ outcome: "failed", reason: "call-failed" });
		expect(rows.every((r) => !String(r.note).includes("123-45"))).toBe(true);
	});

	test("a missing answer is a failure, not a silent zero", async () => {
		const out = await gateLearning(
			{ events: ["x"] },
			{ apiKey: "k", ask: async () => answers({ task_success: 0.9, reusable_correction: 0.9 }) },
		);
		expect(out.outcome).toBe("failed");
	});
});

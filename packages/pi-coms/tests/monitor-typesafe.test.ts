// tests/monitor-typesafe.test.ts
// Greptile PR #912: parse a REAL jev-1.13.0 response through askSystemOne rather
// than an injected, already-typed one. The body is verbatim from a live call on
// 2026-09-26 (triage choice + a noul); a schema drift here would void every
// round and silently send every finding.
import { afterEach, describe, expect, test } from "bun:test";
import { askSystemOne } from "../scripts/monitor/typesafe.ts";

const CAPTURED = {
	model: "jev-1.13.0",
	answers: {
		triage: {
			type: "choice",
			choice: "investigate_now",
			confidence: 0.48,
			probabilities: { critical: 0.39, investigate_now: 0.61, investigate_later: 0, routine: 0 },
		},
		dup: { type: "noul", noul: 0.03 },
	},
	usage: { input_tokens: 460, output_tokens: 76 },
};

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
});

function stubFetch(status: number, body: unknown): void {
	globalThis.fetch = (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
}

describe("askSystemOne", () => {
	test("parses the captured choice + noul response", async () => {
		stubFetch(200, CAPTURED);
		const out = await askSystemOne({ state: {}, questions: {}, apiKey: "k" });
		const triage = out.answers.triage;
		expect(triage?.type).toBe("choice");
		if (triage?.type === "choice") expect(triage.probabilities.routine).toBe(0);
		expect(out.answers.dup).toEqual({ type: "noul", noul: 0.03 });
	});

	test("rejects a choice answer missing its probabilities", async () => {
		const broken = structuredClone(CAPTURED) as { answers: { triage: Record<string, unknown> } };
		delete broken.answers.triage.probabilities;
		stubFetch(200, broken);
		await expect(askSystemOne({ state: {}, questions: {}, apiKey: "k" })).rejects.toThrow();
	});

	test("reports a non-2xx by status only", async () => {
		stubFetch(503, { echo: "state text that must not reach a log" });
		await expect(askSystemOne({ state: {}, questions: {}, apiKey: "k" })).rejects.toThrow(
			"TypeSafe request failed with status 503",
		);
	});
});

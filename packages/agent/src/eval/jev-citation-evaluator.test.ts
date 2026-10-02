// packages/agent/src/eval/jev-citation-evaluator.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Run } from "langsmith/schemas";
import { jevCitationFeedback, jevCitationGrounding } from "./jev-citation-evaluator.ts";
import { jevEvalMetadata } from "./jev-metadata.ts";

describe("jevCitationFeedback", () => {
	test("one weak citation fails the whole response, like citationGrounding", () => {
		const [fb] = jevCitationFeedback(
			{
				ok: true,
				probabilities: [
					{ filename: "a.md", p: 0.97 },
					{ filename: "b.md", p: 0.2 },
				],
			},
			[],
		);
		expect(fb?.score).toBe(0);
		expect(fb?.comment).toContain("min p(grounded)=0.200");
	});

	test("all above threshold passes", () => {
		const [fb] = jevCitationFeedback({ ok: true, probabilities: [{ filename: "a.md", p: 0.9 }] }, []);
		expect(fb?.score).toBe(1);
	});

	test("an unknown filename scores 0 even when the Jev call failed", () => {
		const [fb] = jevCitationFeedback({ ok: false, reason: "boom" }, ["made-up.md"]);
		expect(fb?.score).toBe(0);
		expect(fb?.comment).toContain("made-up.md");
	});

	test("a failed call records no score rather than a pass", () => {
		const [fb] = jevCitationFeedback({ ok: false, reason: "status 500" }, []);
		expect(fb?.score).toBeUndefined();
	});
});

describe("jevEvalMetadata", () => {
	test("no key means Jev is off even with both gates on", () => {
		expect(jevEvalMetadata({ NODE_ENV: "production" }).jev).toBe(false);
	});

	test("a key with one gate killed reports the other", () => {
		const m = jevEvalMetadata({ NODE_ENV: "production", TYPESAFE_API_KEY: "k", ACTION_SELECTOR_ENABLED: "false" });
		expect(m).toMatchObject({ jev: true, jevActionSelector: false, jevAtlassianRerank: true });
	});
});

// SIO-1921 parity. A dummy key gets past the early return; neither case calls Jev, because
// with no known runbook cited only the shared unknown-filename pre-check runs.
describe("jevCitationGrounding evidence parity (SIO-1921)", () => {
	const saved = { NODE_ENV: process.env.NODE_ENV, TYPESAFE_API_KEY: process.env.TYPESAFE_API_KEY };
	beforeEach(() => {
		process.env.NODE_ENV = "production";
		process.env.TYPESAFE_API_KEY = "dummy-key-never-sent";
	});
	afterEach(() => {
		process.env.NODE_ENV = saved.NODE_ENV;
		if (saved.TYPESAFE_API_KEY === undefined) delete process.env.TYPESAFE_API_KEY;
		else process.env.TYPESAFE_API_KEY = saved.TYPESAFE_API_KEY;
	});
	const response = "MR !392 touched `Product.java` and `CHANGELOG.md`.";

	test("an evidence-quoted .md file yields no verdict instead of a 0", async () => {
		const run = {
			outputs: { output: { response, subagentReports: { gitlab: "MR !392 files: Product.java, CHANGELOG.md" } } },
		} as unknown as Run;
		expect(await jevCitationGrounding(run)).toEqual([]);
	});

	test("the same response without that evidence is still flagged", async () => {
		const run = { outputs: { output: { response } } } as unknown as Run;
		const [fb] = await jevCitationGrounding(run);
		expect(fb?.score).toBe(0);
	});
});

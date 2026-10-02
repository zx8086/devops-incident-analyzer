// packages/agent/src/eval/jev-citation-evaluator.test.ts
import { describe, expect, test } from "bun:test";
import { jevCitationFeedback } from "./jev-citation-evaluator.ts";
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

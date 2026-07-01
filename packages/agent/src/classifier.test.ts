// packages/agent/src/classifier.test.ts
//
// SIO-1028: patternClassify is the LLM-free fast path. These tests pin the recall
// keyword regex added to COMPLEX_PATTERNS -- history phrasing must classify complex
// (so the knowledge-graph enrichment path runs) without an LLM call, and the
// pre-existing simple/complex behavior must be unchanged.

import { describe, expect, test } from "bun:test";
import { _testOnly } from "./classifier.ts";

const { patternClassify } = _testOnly;

describe("patternClassify recall phrasing (SIO-1028)", () => {
	const recallQueries = [
		"have we seen this before?",
		"what were the prior incidents?",
		"anything recurring lately?",
		"what went wrong last month?",
		"has this happened previously?",
		"is there any history of kafka issues?",
		"have we had this outage before?",
	];

	for (const q of recallQueries) {
		test(`"${q}" -> complex`, () => {
			expect(patternClassify(q)).toBe("complex");
		});
	}
});

describe("patternClassify regressions (SIO-1028)", () => {
	test("greetings still classify simple", () => {
		expect(patternClassify("hi")).toBe("simple");
		expect(patternClassify("thanks")).toBe("simple");
		expect(patternClassify("what can you do")).toBe("simple");
	});

	test("infra queries still classify complex", () => {
		expect(patternClassify("kafka consumer lag")).toBe("complex");
		expect(patternClassify("check elasticsearch cluster health")).toBe("complex");
	});

	test("a neutral non-recall, non-infra phrase still falls through to the LLM (null)", () => {
		// no simple, complex, or recall pattern -> defer to the LLM classifier
		expect(patternClassify("tell me a joke about ducks")).toBeNull();
	});
});

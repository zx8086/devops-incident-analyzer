// agent/src/atlassian-rerank.test.ts
// SIO-1837. The ask function is injected rather than mock.module'd: the network
// call is the one thing a unit test cannot make, and every response body below is
// the shape a real jev-1.13.0 call returned on 2026-09-20 (score/confidence/
// legend/probabilities + usage), not one invented from the docs.

import { describe, expect, test } from "bun:test";
import type { AtlassianLinkedIssue } from "@devops-agent/shared";
import {
	type AskSystemOne,
	buildIncidentQuery,
	isAtlassianRerankEnabled,
	RERANK_DROP_BELOW,
	rerankLinkedIssues,
} from "./atlassian-rerank.ts";
import type { SystemOneResponse } from "./typesafe-client.ts";

function issue(key: string, summary: string, extra: Partial<AtlassianLinkedIssue> = {}): AtlassianLinkedIssue {
	return { key, summary, status: "Open", ...extra };
}

// A real response body, with the score swapped per call.
function response(score: number, confidence = 0.9, inputTokens = 400): SystemOneResponse {
	return {
		model: "jev-1.13.0",
		answers: {
			relatedness: {
				type: "score",
				score,
				confidence,
				legend: { "0": "Unrelated", "1": "Generic", "2": "Same service", "3": "Same failure" },
				probabilities: { "0": 0, "1": 0, "2": 0.02, "3": 0.98 },
			},
		},
		usage: { input_tokens: inputTokens, output_tokens: 19 },
	};
}

/** Answers in the order the issues were passed. */
function askReturning(scores: number[]): { ask: AskSystemOne; sent: unknown[] } {
	const sent: unknown[] = [];
	let i = 0;
	const ask = (async (options: Parameters<AskSystemOne>[0]) => {
		sent.push(options.state);
		const score = scores[i++] ?? 0;
		return response(score);
	}) as AskSystemOne;
	return { ask, sent };
}

describe("isAtlassianRerankEnabled", () => {
	test("defaults ON, and only false/0 disable it", () => {
		expect(isAtlassianRerankEnabled({})).toBe(true);
		expect(isAtlassianRerankEnabled({ ATLASSIAN_RERANK_ENABLED: "true" })).toBe(true);
		expect(isAtlassianRerankEnabled({ ATLASSIAN_RERANK_ENABLED: "FALSE" })).toBe(false);
		expect(isAtlassianRerankEnabled({ ATLASSIAN_RERANK_ENABLED: "0" })).toBe(false);
	});
});

describe("buildIncidentQuery", () => {
	test("carries services, severity and the report's first paragraph", () => {
		const query = buildIncidentQuery(
			{
				normalizedIncident: { severity: "high" },
				investigationFocus: undefined,
				finalAnswer: "# Report\n\nConsumers are timing out on KV reads.\n\nSecond paragraph is not needed.",
			},
			["order-service"],
		);
		expect(query).toContain("order-service");
		expect(query).toContain("high");
		expect(query).toContain("Consumers are timing out on KV reads.");
		expect(query).not.toContain("Second paragraph");
	});

	test("redacts PII before the text can leave the account", () => {
		const query = buildIncidentQuery(
			{ normalizedIncident: undefined, investigationFocus: undefined, finalAnswer: "Reported by alice@example.com" },
			[],
		);
		expect(query).not.toContain("alice@example.com");
		expect(query).toContain("[EMAIL_REDACTED]");
	});

	test("empty when there is no report text and no focus", () => {
		expect(
			buildIncidentQuery({ normalizedIncident: undefined, investigationFocus: undefined, finalAnswer: undefined }, []),
		).toBe("");
	});
});

describe("rerankLinkedIssues", () => {
	const incident = "Services: order-service. Consumers timing out on Couchbase KV reads";

	test("orders by score and drops everything below the threshold", async () => {
		const issues = [
			issue("A-1", "unrelated retro"),
			issue("A-2", "KV timeouts"),
			issue("A-3", "same service, other bug"),
		];
		const { ask } = askReturning([0.02, 2.96, 2.04]);
		const out = await rerankLinkedIssues(issues, incident, { apiKey: "k", ask });

		expect(out).not.toBeNull();
		expect(out?.issues.map((i) => i.key)).toEqual(["A-2", "A-3"]);
		expect(out?.dropped).toBe(1);
		expect(out?.issues[0]?.relevance).toBeCloseTo(2.96, 6);
		expect(out?.issues[0]?.relevanceConfidence).toBeCloseTo(0.9, 6);
	});

	test("ties keep the tool's order while non-ties still sort", async () => {
		// Ordering leans on Array.prototype.sort being stable rather than on an
		// explicit tie-break (see the comment in rerankLinkedIssues). This pins that
		// assumption: the sort must MOVE the winner to the front while leaving the
		// three equal scores in the order the tool returned them.
		const issues = [
			issue("A-1", "tie one"),
			issue("A-2", "tie two"),
			issue("A-3", "tie three"),
			issue("A-4", "winner"),
		];
		const { ask } = askReturning([2.5, 2.5, 2.5, 2.9]);
		const out = await rerankLinkedIssues(issues, incident, { apiKey: "k", ask });
		expect(out?.issues.map((i) => i.key)).toEqual(["A-4", "A-1", "A-2", "A-3"]);
	});

	test("a score exactly at the threshold is kept, not dropped", async () => {
		// The boundary is the whole gate; an off-by-one here silently hides tickets.
		const { ask } = askReturning([RERANK_DROP_BELOW]);
		const out = await rerankLinkedIssues([issue("A-1", "borderline")], incident, { apiKey: "k", ask });
		expect(out?.issues).toHaveLength(1);
		expect(out?.dropped).toBe(0);
	});

	test("one failed request discards the whole round", async () => {
		// A partially scored list would mix judged and unjudged tickets in one
		// ordering, which reads as ranked while being arbitrary.
		let calls = 0;
		const ask = (async () => {
			calls += 1;
			if (calls === 2) throw new Error("boom");
			return response(2.9);
		}) as AskSystemOne;
		const out = await rerankLinkedIssues([issue("A-1", "x"), issue("A-2", "y")], incident, { apiKey: "k", ask });
		expect(out).toBeNull();
	});

	test("an answer missing the question id is a failure, not a zero", async () => {
		// Scoring it 0 would hide the ticket on the strength of a malformed reply.
		const ask = (async () => ({
			model: "jev-1.13.0",
			answers: {},
			usage: { input_tokens: 1, output_tokens: 1 },
		})) as AskSystemOne;
		const out = await rerankLinkedIssues([issue("A-1", "x")], incident, { apiKey: "k", ask });
		expect(out).toBeNull();
	});

	test("an aborted deadline returns null rather than throwing", async () => {
		const ask = (async () => {
			throw new DOMException("The operation was aborted.", "TimeoutError");
		}) as AskSystemOne;
		const out = await rerankLinkedIssues([issue("A-1", "x")], incident, { apiKey: "k", ask });
		expect(out).toBeNull();
	});

	test("null for an empty list or an empty incident query", async () => {
		const { ask } = askReturning([3]);
		expect(await rerankLinkedIssues([], incident, { apiKey: "k", ask })).toBeNull();
		expect(await rerankLinkedIssues([issue("A-1", "x")], "", { apiKey: "k", ask })).toBeNull();
	});

	test("sends the ticket body and redacts PII in what it sends", async () => {
		const issues = [
			issue("A-1", "KV timeouts", { descriptionExcerpt: "Reported by bob@example.com on the order path" }),
		];
		const { ask, sent } = askReturning([2.9]);
		await rerankLinkedIssues(issues, incident, { apiKey: "k", ask });

		const state = sent[0] as { ticket: { summary: string; description?: string } };
		expect(state.ticket.description).toContain("order path");
		expect(state.ticket.description).not.toContain("bob@example.com");
	});

	test("reports the model, tokens and the two orderings for the metrics row", async () => {
		const issues = [issue("A-1", "low"), issue("A-2", "high")];
		const { ask } = askReturning([1.5, 2.9]);
		const out = await rerankLinkedIssues(issues, incident, { apiKey: "k", ask });

		expect(out?.model).toBe("jev-1.13.0");
		expect(out?.inputTokens).toBe(800);
		// A-2 was second deterministically and first after the rerank: the
		// disagreement this epic exists to measure.
		expect(out?.deterministicRanks).toEqual([1, 0]);
		expect(out?.jevRanks).toEqual([0, 1]);
	});
});

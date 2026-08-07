// packages/agent/src/eval/citation-grounding-evaluator.test.ts
// SIO-1442 tier 3: does the agent's final response, when it cites a runbook, cite one that
// actually exists and actually says what the response claims it says? No structured citation
// format exists in this codebase (confirmed: the aggregator prompt renders each selected
// runbook under a "#### filename" heading, but nothing instructs the LLM to cite that filename
// back). findCitedRunbooks is therefore a best-effort filename/title match, deliberately over-
// inclusive (false positives here just mean "graded a citation that wasn't really one" -- safe;
// false negatives mean "missed a real citation" -- also safe, just fewer graded citations). The
// misrepresentation check (does the claim match the runbook's real content) is semantic and not
// regex-able, so it's an LLM judge -- tested only via the pure extraction/feedback-shaping
// pieces here, same split as SIO-1440's spec-contradiction-judge.ts.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	citationJudgeFeedback,
	deriveTitleFromContent,
	findCitedRunbooks,
	findUnknownMdCitations,
	validateVerdictCoverage,
} from "./citation-grounding-evaluator.ts";

const AGENTS_DIR = join(import.meta.dir, "../../../../agents/incident-analyzer");

const knowledge = [
	{
		category: "runbooks-couchbase",
		filename: "database-slow-queries.md",
		content: "# Couchbase Slow Query Investigation\n...",
		title: "Couchbase Slow Query Investigation",
	},
	{
		category: "runbooks-kafka",
		filename: "kafka-consumer-lag.md",
		content: "# Kafka Consumer Lag\n...",
		title: "Kafka Consumer Lag Investigation",
	},
];

describe("findCitedRunbooks", () => {
	test("finds a citation by exact filename", () => {
		const cited = findCitedRunbooks(
			"Per the database-slow-queries.md runbook, check the primary index scans.",
			knowledge,
		);
		expect(cited.map((c) => c.filename)).toEqual(["database-slow-queries.md"]);
	});

	test("finds a citation by title text, not just filename", () => {
		const cited = findCitedRunbooks("Following the Couchbase Slow Query Investigation procedure...", knowledge);
		expect(cited.map((c) => c.filename)).toEqual(["database-slow-queries.md"]);
	});

	test("finds multiple distinct citations in one response", () => {
		const cited = findCitedRunbooks(
			"See database-slow-queries.md for the query analysis and kafka-consumer-lag.md for the lag investigation.",
			knowledge,
		);
		expect(cited.map((c) => c.filename).sort()).toEqual(["database-slow-queries.md", "kafka-consumer-lag.md"]);
	});

	test("does not fabricate a citation to a runbook filename that was never mentioned", () => {
		const cited = findCitedRunbooks("No specific runbook was consulted for this investigation.", knowledge);
		expect(cited).toEqual([]);
	});

	test("does not match a substring that merely resembles a filename (no false hallucinated match)", () => {
		const cited = findCitedRunbooks("The database was slow, likely due to a missing index.", knowledge);
		expect(cited).toEqual([]);
	});

	test("dedups a filename cited more than once in the same response", () => {
		const cited = findCitedRunbooks(
			"database-slow-queries.md shows the issue. Per database-slow-queries.md, escalate to DBA.",
			knowledge,
		);
		expect(cited).toHaveLength(1);
	});
});

// CodeRabbit (PR #633): findCitedRunbooks alone only ever POSITIVELY matches a KNOWN filename --
// a response citing a completely invented filename (e.g. "invented-runbook.md") produced no
// match and therefore no finding at all, missing the exact hallucination case this evaluator
// exists to catch (the ticket's own stated acceptance criteria). findUnknownMdCitations scans
// independently for anything shaped like a .md filename and flags names NOT in the known set.
describe("findUnknownMdCitations", () => {
	const knownFilenames = ["database-slow-queries.md", "kafka-consumer-lag.md"];

	test("flags a .md-shaped filename that is not in the known set", () => {
		const unknown = findUnknownMdCitations(
			"Per the invented-runbook.md procedure, restart the service.",
			knownFilenames,
		);
		expect(unknown).toEqual(["invented-runbook.md"]);
	});

	test("does not flag a real, known filename", () => {
		const unknown = findUnknownMdCitations("Per database-slow-queries.md, check the indexes.", knownFilenames);
		expect(unknown).toEqual([]);
	});

	test("does not flag prose with no .md-shaped token at all", () => {
		const unknown = findUnknownMdCitations("No specific runbook was consulted.", knownFilenames);
		expect(unknown).toEqual([]);
	});

	test("dedups a repeated unknown filename", () => {
		const unknown = findUnknownMdCitations(
			"See invented-runbook.md for details. Per invented-runbook.md, escalate.",
			knownFilenames,
		);
		expect(unknown).toEqual(["invented-runbook.md"]);
	});

	test("flags multiple distinct unknown filenames", () => {
		const unknown = findUnknownMdCitations("See fake-one.md and fake-two.md for the analysis.", knownFilenames);
		expect(unknown.sort()).toEqual(["fake-one.md", "fake-two.md"]);
	});
});

// deriveTitleFromContent exists because KnowledgeEntry (manifest-loader.ts) does not carry a
// title field through the loader boundary -- OKF's title: frontmatter is parsed but dropped.
// Every runbook puts its title as the first "# Heading" line of the stripped content.
describe("deriveTitleFromContent", () => {
	test("extracts the title from a leading H1 heading", () => {
		expect(deriveTitleFromContent("# Couchbase Slow Query Investigation\n\nSome body text.")).toBe(
			"Couchbase Slow Query Investigation",
		);
	});

	test("returns empty string when there is no H1 heading (degrades to filename-only matching)", () => {
		expect(deriveTitleFromContent("Just prose, no heading.")).toBe("");
	});

	test("real runbook content in this repo actually has a derivable title", () => {
		const content = readFileSync(join(AGENTS_DIR, "knowledge/couchbase/runbooks/database-slow-queries.md"), "utf-8");
		// The raw file still has frontmatter; strip it the same way stripFrontmatter does (content
		// after the second "---" line) to simulate what KnowledgeEntry.content actually contains.
		const stripped = content.replace(/^---\n[\s\S]*?\n---\n/, "").trim();
		expect(deriveTitleFromContent(stripped)).toBe("Couchbase Slow Query Investigation");
	});
});

// CodeRabbit (PR #633): the LLM is asked (in prose only) for "one verdict per runbook provided,
// in the order given," but nothing enforced that contract -- a response with zero verdicts, a
// subset, duplicates, or verdicts for unrelated filenames still passed CitationGradeSchema's
// shape check and would have been silently trusted as a complete, correct grading. Same class of
// "structurally valid JSON that doesn't actually answer the question" risk as tier 1's .catch()
// false-clean-pass bugs. Require exact ordered coverage; anything else is treated as a failure.
describe("validateVerdictCoverage", () => {
	const cited = [
		{ filename: "database-slow-queries.md", content: "..." },
		{ filename: "kafka-consumer-lag.md", content: "..." },
	];

	test("exact ordered coverage is valid", () => {
		const verdicts = [
			{ filename: "database-slow-queries.md", grounded: true, reasoning: "ok" },
			{ filename: "kafka-consumer-lag.md", grounded: true, reasoning: "ok" },
		];
		expect(validateVerdictCoverage(verdicts, cited)).toBe(true);
	});

	test("empty verdicts against a non-empty cited set is invalid", () => {
		expect(validateVerdictCoverage([], cited)).toBe(false);
	});

	test("a partial verdict list (missing one runbook) is invalid", () => {
		const verdicts = [{ filename: "database-slow-queries.md", grounded: true, reasoning: "ok" }];
		expect(validateVerdictCoverage(verdicts, cited)).toBe(false);
	});

	test("a duplicate verdict for the same filename is invalid", () => {
		const verdicts = [
			{ filename: "database-slow-queries.md", grounded: true, reasoning: "ok" },
			{ filename: "database-slow-queries.md", grounded: true, reasoning: "ok" },
		];
		expect(validateVerdictCoverage(verdicts, cited)).toBe(false);
	});

	test("a verdict for an unrelated filename is invalid", () => {
		const verdicts = [
			{ filename: "database-slow-queries.md", grounded: true, reasoning: "ok" },
			{ filename: "some-other-file.md", grounded: true, reasoning: "ok" },
		];
		expect(validateVerdictCoverage(verdicts, cited)).toBe(false);
	});

	test("reordered but complete coverage is still valid (order within the set does not matter)", () => {
		const verdicts = [
			{ filename: "kafka-consumer-lag.md", grounded: true, reasoning: "ok" },
			{ filename: "database-slow-queries.md", grounded: true, reasoning: "ok" },
		];
		expect(validateVerdictCoverage(verdicts, cited)).toBe(true);
	});
});

describe("citationJudgeFeedback", () => {
	test("no citations and no unknown filenames yields no verdict (nothing to grade)", () => {
		const feedback = citationJudgeFeedback({ ok: true, verdicts: [] }, []);
		expect(feedback).toEqual([]);
	});

	test("all citations grounded, no unknown filenames scores 1", () => {
		const feedback = citationJudgeFeedback(
			{
				ok: true,
				verdicts: [
					{ filename: "database-slow-queries.md", grounded: true, reasoning: "claim matches runbook content" },
				],
			},
			[],
		);
		expect(feedback).toEqual([
			{ key: "citation_grounding", score: 1, comment: "1/1 citation(s) grounded in real runbook content" },
		]);
	});

	test("a misrepresented citation scores 0 and names the offending filename", () => {
		const feedback = citationJudgeFeedback(
			{
				ok: true,
				verdicts: [
					{ filename: "database-slow-queries.md", grounded: true, reasoning: "ok" },
					{
						filename: "kafka-consumer-lag.md",
						grounded: false,
						reasoning: "response claims this runbook covers Couchbase index tuning; it does not",
					},
				],
			},
			[],
		);
		expect(feedback).toHaveLength(1);
		expect(feedback[0]?.score).toBe(0);
		expect(feedback[0]?.comment).toContain("kafka-consumer-lag.md");
	});

	// CodeRabbit precedent from tier 1 (PR #630/#632): a failed judge call must not collapse to
	// the same shape as "the judge ran and found everything grounded" -- score must be omitted,
	// not defaulted to 1, so a broken judge call cannot silently read as a passing grade.
	test("a failed judge call yields neither a pass nor a fail score", () => {
		const feedback = citationJudgeFeedback({ ok: false, reason: "OpenAI request failed" }, []);
		expect(feedback).toHaveLength(1);
		expect(feedback[0]?.score).toBeUndefined();
		expect(feedback[0]?.comment).toContain("OpenAI request failed");
	});

	// CodeRabbit (PR #633): a citation to a completely invented filename must score 0 even when
	// there were no KNOWN citations to send to the judge at all (cited.length === 0 -> judge is
	// never even called, per judgeCitationGrounding's short-circuit) -- the hallucination itself
	// is the finding, independent of whether the judge ran.
	test("an unknown/hallucinated filename scores 0 even with no judge verdicts to grade", () => {
		const feedback = citationJudgeFeedback({ ok: true, verdicts: [] }, ["invented-runbook.md"]);
		expect(feedback).toHaveLength(1);
		expect(feedback[0]?.score).toBe(0);
		expect(feedback[0]?.comment).toContain("invented-runbook.md");
	});

	test("an unknown filename is reported alongside real grounding verdicts, not instead of them", () => {
		const feedback = citationJudgeFeedback(
			{
				ok: true,
				verdicts: [{ filename: "database-slow-queries.md", grounded: true, reasoning: "ok" }],
			},
			["invented-runbook.md"],
		);
		expect(feedback).toHaveLength(1);
		expect(feedback[0]?.score).toBe(0);
		expect(feedback[0]?.comment).toContain("invented-runbook.md");
	});
});

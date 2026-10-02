// packages/agent/src/eval/citation-grounding-evaluator.test.ts
// SIO-1442 tier 3: does the agent's final response, when it cites a runbook, cite one that
// actually exists and actually says what the response claims it says? No structured citation
// format exists in this codebase (confirmed: the aggregator prompt renders each selected
// runbook under a "#### filename" heading, but nothing instructs the LLM to cite that filename
// back). findCitedRunbooks is therefore a best-effort filename/title match, deliberately over-
// inclusive (false positives here just mean "graded a citation that wasn't really one" -- safe;
// false negatives mean "missed a real citation" -- also safe, just fewer graded citations). The
// misrepresentation check itself is Jev's (jev-citation-evaluator.ts, SIO-1935); this file tests
// the shared detection and output-reading pieces.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Run } from "langsmith/schemas";
import {
	deriveTitleFromContent,
	findCitedRunbooks,
	findUnknownMdCitations,
	readCitationGroundingOutput,
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

	// SIO-1921: verbatim from the DEVOPS-1353 smoke run, where both citation evaluators scored 0
	// on a repository file the GitLab sub-agent reported as touched by an MR.
	test("does not flag a .md name the sub-agent evidence also contains", () => {
		const unknown = findUnknownMdCitations(
			"The last change, MR !392, touched `OptionResponse.java`, `Product.java` and `CHANGELOG.md`.",
			knownFilenames,
			"MR !392 changed files: src/OptionResponse.java, src/Product.java, CHANGELOG.md",
		);
		expect(unknown).toEqual([]);
	});

	test("still flags an invented name when the evidence does not contain it", () => {
		const unknown = findUnknownMdCitations(
			"Per invented-runbook.md, restart. MR !392 touched CHANGELOG.md.",
			knownFilenames,
			"MR !392 changed files: CHANGELOG.md",
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

// CodeRabbit (PR #633, round 3): the previous Array.isArray(...) check validated the array
// wrapper but not element shape -- a malformed knowledgeSnapshot element (e.g. {} missing
// filename/content/title) passed through and crashed findCitedRunbooks downstream
// (entry.title.trim() on undefined). Live-verified: findCitedRunbooks("see runbook.md", [{}])
// against the OLD code threw "Cannot read properties of undefined (reading 'trim')".
describe("readCitationGroundingOutput", () => {
	test("valid output with well-shaped knowledgeSnapshot elements parses", () => {
		const run = {
			outputs: {
				output: {
					response: "see database-slow-queries.md",
					knowledgeSnapshot: [{ filename: "database-slow-queries.md", content: "...", title: "Slow Queries" }],
				},
			},
		} as unknown as Run;
		expect(readCitationGroundingOutput(run)).toEqual({
			response: "see database-slow-queries.md",
			candidates: [{ filename: "database-slow-queries.md", content: "...", title: "Slow Queries" }],
			evidence: "",
		});
	});

	test("a knowledgeSnapshot element missing required fields is rejected, not crashed on downstream", () => {
		const run = {
			outputs: { output: { response: "see runbook.md", knowledgeSnapshot: [{}] } },
		} as unknown as Run;
		expect(readCitationGroundingOutput(run)).toBeUndefined();
	});

	test("a knowledgeSnapshot element that is a bare primitive is rejected", () => {
		const run = {
			outputs: { output: { response: "see runbook.md", knowledgeSnapshot: [null] } },
		} as unknown as Run;
		expect(readCitationGroundingOutput(run)).toBeUndefined();
	});

	test("missing knowledgeSnapshot defaults to empty candidates, response still required", () => {
		const run = { outputs: { output: { response: "no citations here" } } } as unknown as Run;
		expect(readCitationGroundingOutput(run)).toEqual({ response: "no citations here", candidates: [], evidence: "" });
	});

	test("subagentReports are joined into evidence", () => {
		const run = {
			outputs: { output: { response: "r", subagentReports: { gitlab: "touched CHANGELOG.md", elastic: "no hits" } } },
		} as unknown as Run;
		expect(readCitationGroundingOutput(run)?.evidence).toBe("touched CHANGELOG.md\nno hits");
	});

	test("missing response entirely yields undefined", () => {
		const run = { outputs: { output: { knowledgeSnapshot: [] } } } as unknown as Run;
		expect(readCitationGroundingOutput(run)).toBeUndefined();
	});
});

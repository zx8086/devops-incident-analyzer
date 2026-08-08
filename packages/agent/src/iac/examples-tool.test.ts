// agent/src/iac/examples-tool.test.ts
//
// SIO-1450: the LOCAL lookup-examples tool for elastic-iac. Mirrors local-tools.test.ts's
// pure-handler-first shape (runExamplesLookup / createLookupExamplesTool), but needs no
// module mocking -- matching is a synchronous read over on-disk markdown, not a network call.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createLookupExamplesTool, runExamplesLookup } from "./examples-tool.ts";

const TEST_AGENT = "examples-tool-test-fixture";

function fixtureDir(): string {
	return join(import.meta.dir, "..", "..", "..", "..", "agents", TEST_AGENT, "examples");
}

function writeExample(filename: string, content: string): void {
	writeFileSync(join(fixtureDir(), filename), content, "utf-8");
}

beforeEach(() => {
	mkdirSync(fixtureDir(), { recursive: true });
});

afterEach(() => {
	rmSync(join(fixtureDir(), ".."), { recursive: true, force: true });
});

describe("runExamplesLookup", () => {
	test("returns an explicit empty result when no example file matches the query", async () => {
		writeExample(
			"kafka-lag.md",
			["# Consumer group lag looked wrong", "Tags: kafka, consumer-lag", "", "Body text about kafka."].join("\n"),
		);

		const out = await runExamplesLookup(TEST_AGENT, { query: "elastic cluster health timeout" });

		expect(out).toBe("No matching example found.");
	});

	test("returns the matching example block when the query hits a tag", async () => {
		writeExample(
			"cluster-health-timeout.md",
			[
				"# Cluster health check timed out",
				"Tags: elastic, cluster-health, timeout",
				"",
				"The first call to elastic_get_cluster_health timed out. Retrying with a narrower",
				"index pattern resolved it.",
			].join("\n"),
		);

		const out = await runExamplesLookup(TEST_AGENT, { query: "cluster health timeout" });

		expect(out).toContain("Cluster health check timed out");
		expect(out).toContain("narrower");
	});

	test("returns no more than 3 matches even when every example matches", async () => {
		for (let i = 0; i < 5; i++) {
			writeExample(
				`generic-${i}.md`,
				[`# Generic example ${i}`, "Tags: general", "", "Some generic recovery body."].join("\n"),
			);
		}

		const out = await runExamplesLookup(TEST_AGENT, { query: "general" });

		const matchCount = out.split("\n## ").length; // headings are joined with "\n## "
		expect(matchCount).toBeLessThanOrEqual(3);
	});

	test("returns the empty-result string when the agent has no examples directory at all", async () => {
		rmSync(fixtureDir(), { recursive: true, force: true });

		const out = await runExamplesLookup(TEST_AGENT, { query: "anything" });

		expect(out).toBe("No matching example found.");
	});

	// SIO-1450 regression: found via manual smoke test against real content authored with a
	// blank line between the heading and "Tags:" (standard markdown spacing) -- the parser
	// assumed line[1] was always the tags line, so with a blank line at [1] the real tags line
	// [2] was silently treated as body text and never parsed as tags at all.
	test("parses the tags line even when a blank line separates it from the heading", async () => {
		writeExample("blank-line-before-tags.md", ["# Some heading", "", "Tags: alpha, beta", "", "Body text."].join("\n"));

		const out = await runExamplesLookup(TEST_AGENT, { query: "beta" });

		expect(out).toContain("Some heading");
	});

	// SIO-1450 regression: found via manual smoke test with two real examples whose headings
	// coincidentally both contain "not" ("deployment not found" / "...not one"). A stopword
	// list that only covers articles/copulas/wh-words let this common connective word through.
	test("does not match on the connective word 'not' shared between two unrelated headings", async () => {
		writeExample(
			"deployment-not-found.md",
			["# Deployment not found for that name", "Tags: deployment, not found", "", "Body."].join("\n"),
		);
		writeExample("three-reads.md", ["# Needs three reads, not one", "Tags: version, upgrade", "", "Body."].join("\n"));

		const out = await runExamplesLookup(TEST_AGENT, { query: "deployment not found for a cluster name" });

		expect(out).toContain("Deployment not found");
		expect(out).not.toContain("Needs three reads");
	});

	// A word present only in the free-text body (not heading/tags) must not be enough to match
	// an unrelated query -- the body is illustrative detail, not curated matching signal.
	test("does not match on a word shared only with body prose, not heading/tags", async () => {
		writeExample(
			"version-upgrade.md",
			[
				"# Version-upgrade needs three reads",
				"Tags: version, upgrade, drift, query_structure",
				"",
				"A question like 'is eu-b2b on the version the repo says it should be' is not answered",
				"by a single read.",
			].join("\n"),
		);

		const out = await runExamplesLookup(TEST_AGENT, {
			query: "totally unrelated kafka consumer lag question",
		});

		expect(out).toBe("No matching example found.");
	});
});

describe("tool factories", () => {
	test("expose the documented name + zod schema", () => {
		const tool = createLookupExamplesTool(TEST_AGENT);
		expect(tool.name).toBe("lookup_examples");
		expect(tool.description.toLowerCase()).toContain("example");
	});
});

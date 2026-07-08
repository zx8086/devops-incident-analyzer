// packages/agent/src/correlation/extractors/couchbase.test.ts
import { describe, expect, test } from "bun:test";
import type { ToolOutput } from "@devops-agent/shared";
import { extractCouchbaseFindings } from "./couchbase.ts";

describe("extractCouchbaseFindings", () => {
	test("returns empty findings when no relevant tool outputs are present", () => {
		const outputs: ToolOutput[] = [{ toolName: "capella_get_fatal_requests", rawJson: [] }];
		expect(extractCouchbaseFindings(outputs)).toEqual({});
	});

	test("maps capella_get_longest_running_queries bare-array response to slowQueries[]", () => {
		const outputs: ToolOutput[] = [
			{
				toolName: "capella_get_longest_running_queries",
				rawJson: [
					{
						statement: "SELECT * FROM bucket WHERE k = $1 OFFSET 100000",
						avgServiceTime: "2.3s",
						lastExecutionTime: "2026-05-07T11:42:00.000Z",
						queries: 17,
					},
					{
						statement: "SELECT meta(b).id FROM bucket b",
						avgServiceTime: "1.1s",
						lastExecutionTime: "2026-05-06T19:00:00.000Z",
						queries: 4,
					},
				],
			},
		];
		const findings = extractCouchbaseFindings(outputs);
		expect(findings.slowQueries).toHaveLength(2);
		expect(findings.slowQueries?.[0]?.statement).toContain("OFFSET");
		expect(findings.slowQueries?.[0]?.lastExecutionTime).toBe("2026-05-07T11:42:00.000Z");
	});

	test("ignores malformed entries (missing required statement) and keeps valid siblings", () => {
		const outputs: ToolOutput[] = [
			{
				toolName: "capella_get_longest_running_queries",
				rawJson: [
					{ avgServiceTime: "1.0s", queries: 1 },
					{ statement: "valid one", queries: 2 },
				],
			},
		];
		const findings = extractCouchbaseFindings(outputs);
		expect(findings.slowQueries).toHaveLength(1);
		expect(findings.slowQueries?.[0]?.statement).toBe("valid one");
	});

	test("ignores non-array rawJson (defensive against unexpected response shapes)", () => {
		const outputs: ToolOutput[] = [
			{ toolName: "capella_get_longest_running_queries", rawJson: "upstream returned markdown" },
		];
		expect(extractCouchbaseFindings(outputs)).toEqual({});
	});
});

describe("extractCouchbaseFindings focus scoping (SIO-1030)", () => {
	const queries = (rows: Array<Record<string, unknown>>): ToolOutput => ({
		toolName: "capella_get_longest_running_queries",
		rawJson: rows,
	});

	test("empty focus keeps every slow query (show-all, back-compat)", () => {
		const out = extractCouchbaseFindings(
			[queries([{ statement: "SELECT * FROM prices_v2 b" }, { statement: "SELECT * FROM articles a" }])],
			[],
		);
		expect(out.slowQueries).toHaveLength(2);
	});

	test("keeps queries whose statement names the focus, drops unrelated", () => {
		const out = extractCouchbaseFindings(
			[
				queries([
					{ statement: "SELECT mainSize FROM `prices-api-v2-service` WHERE k = $1" },
					{ statement: "SELECT salesStatus FROM articles WHERE x = 1" },
				]),
			],
			["prices-api-v2-service"],
		);
		expect(out.slowQueries).toHaveLength(1);
		expect(out.slowQueries?.[0]?.statement).toContain("prices-api-v2-service");
	});

	test("legitimately empties the card when no statement names the focus (strict, documented)", () => {
		// A slow query often names a bucket/collection, not the focus service. Under
		// the strict "no exceptions" policy this drops all rows — the honest result.
		const out = extractCouchbaseFindings(
			[queries([{ statement: "SELECT * FROM `product_catalog` WHERE k = $1" }])],
			["prices-api-v2-service"],
		);
		expect(out.slowQueries ?? []).toHaveLength(0);
	});
});

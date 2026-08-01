// tests/runSqlPlusPlusQuery.test.ts
//
// SIO-744: regression test for surfacing the underlying error message in the
// tool response. Previously the catch swallowed the error and returned a flat
// "Failed to execute query", giving the LLM no way to recover.

import { describe, expect, test } from "bun:test";
import type { Bucket } from "couchbase";
import { runQuery } from "../src/tools/runSqlPlusPlusQuery";

function makeBucket(queryImpl: (sql: string) => Promise<unknown>): Bucket {
	return {
		scope: (_name: string) => ({
			query: queryImpl,
		}),
	} as unknown as Bucket;
}

describe("runSqlPlusPlusQuery error surfacing (SIO-744)", () => {
	test("includes the underlying error message in the tool response", async () => {
		const bucket = makeBucket(() => {
			throw new Error("syntax error - at line 3:14, near 'WHRE'");
		});

		const result = await runQuery({ scope_name: "inventory", query: "SELECT * FROM `airline`" }, bucket);

		expect(result.isError).toBe(true);
		const text = (result.content[0] as { text: string }).text;
		expect(text).toContain("Failed to execute query");
		// SIO-1078: the lib helper wraps the underlying error via createError(...,
		// originalError), so AppError.message is the generic "Failed to execute query"
		// and the real N1QL detail lives on AppError.originalError. The tool must surface
		// that cause -- assert the actual stubbed syntax text is present, not merely that
		// the string is longer than the generic prefix (which the old doubled message
		// passed by accident).
		expect(text).toContain("near 'WHRE'");
		expect(text).not.toBe("Failed to execute query: Failed to execute query");
	});

	test("returns isError true when bucket is missing", async () => {
		const result = await runQuery({ scope_name: "inventory", query: "SELECT 1" }, undefined as unknown as Bucket);
		expect(result.isError).toBe(true);
	});
});

describe("runSqlPlusPlusQuery warnings surfacing", () => {
	test("a successful query with N1QL meta.warnings surfaces them in _meta, not the JSON text", async () => {
		// The Couchbase SDK returns status:success + non-empty warnings for advisory
		// conditions (e.g. non-covering index selectivity, sequential-scan fallback) --
		// the row data is complete and correct, but the caveat must reach the agent.
		// Warnings must land in _meta, NOT prefixed onto content[0].text: the agent's
		// tryParseJson does a bare JSON.parse on that text, and a prose prefix would
		// break parsing for every downstream consumer of toolOutputs[].rawJson.
		const bucket = makeBucket(async () => ({
			rows: [{ total: 42 }],
			meta: {
				warnings: [{ code: 4300, message: "No index available for this query, using sequential scan" }],
			},
		}));

		const result = await runQuery({ scope_name: "styles", query: "SELECT COUNT(*) AS total FROM article" }, bucket);

		expect(result.isError).toBe(false);
		const text = (result.content[0] as { text: string }).text;
		expect(() => JSON.parse(text)).not.toThrow();
		expect(JSON.parse(text)).toEqual([{ total: 42 }]);
		expect(result._meta?.warnings).toEqual([
			{ code: 4300, message: "No index available for this query, using sequential scan" },
		]);
	});

	test("a successful distinct-source-count query with warnings surfaces them in _meta", async () => {
		const bucket = makeBucket(async () => ({
			rows: [{ distinct_source_count: 42 }],
			meta: {
				warnings: [{ code: 4300, message: "No index available for this query, using sequential scan" }],
			},
		}));

		const result = await runQuery(
			{ scope_name: "styles", query: "SELECT COUNT(DISTINCT source) AS distinct_source_count FROM article" },
			bucket,
		);

		expect(result.isError).toBe(false);
		const text = (result.content[0] as { text: string }).text;
		expect(text).toBe("Found 42 distinct sources");
		expect(result._meta?.warnings).toEqual([
			{ code: 4300, message: "No index available for this query, using sequential scan" },
		]);
	});

	test("a successful query with no warnings omits _meta.warnings", async () => {
		const bucket = makeBucket(async () => ({
			rows: [{ total: 42 }],
			meta: { warnings: [] },
		}));

		const result = await runQuery({ scope_name: "styles", query: "SELECT COUNT(*) AS total FROM article" }, bucket);

		expect(result.isError).toBe(false);
		expect(result._meta?.warnings).toBeUndefined();
	});
});

describe("runSqlPlusPlusQuery bucket-path guardrail (SIO-1162)", () => {
	test("full bucket.scope.collection path returns a structured bad-query envelope with advice", async () => {
		// The guardrail short-circuits before touching the bucket, so no query impl is needed.
		const bucket = makeBucket(() => {
			throw new Error("should not reach the cluster");
		});

		const result = await runQuery(
			{ scope_name: "inventory", query: "SELECT COUNT(*) FROM `travel`.`inventory`.`airline`" },
			bucket,
		);

		expect(result.isError).toBe(true);
		const text = (result.content[0] as { text: string }).text;
		const parsed = JSON.parse(text) as { _error: { kind: string; category: string; advice?: string } };
		expect(parsed._error.kind).toBe("bad-query");
		expect(parsed._error.category).toBe("bad-query");
		expect(parsed._error.advice).toContain("scope_name");
	});
});

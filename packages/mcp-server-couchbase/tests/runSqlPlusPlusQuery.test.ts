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

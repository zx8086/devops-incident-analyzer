// tests/explainSqlPlusPlusQuery.test.ts
// SIO-1168: regression tests for wiring adviseCouchbaseError into the EXPLAIN
// catch path and auto-enriching "no-index" failures with real advisor DDL.

import { describe, expect, test } from "bun:test";
import type { Bucket } from "couchbase";
import { ParsingFailureError, PlanningFailureError } from "couchbase";
import { explainQuery } from "../src/tools/explainSqlPlusPlusQuery";

function makeBucket(queryImpl: (statement: string) => Promise<unknown>): Bucket {
	return {
		scope: (_name: string) => ({
			query: queryImpl,
		}),
	} as unknown as Bucket;
}

function makePlanningFailureError(firstErrorCode: number): PlanningFailureError {
	const err = new Error("planning failure") as PlanningFailureError;
	Object.setPrototypeOf(err, PlanningFailureError.prototype);
	(err as unknown as { cause: unknown }).cause = { first_error_code: firstErrorCode };
	return err;
}

function makeParsingFailureError(message: string): ParsingFailureError {
	const err = new Error(message) as ParsingFailureError;
	Object.setPrototypeOf(err, ParsingFailureError.prototype);
	return err;
}

describe("explainSqlPlusPlusQuery advice wiring (SIO-1168)", () => {
	test("bad-query failure includes backtick-reserved-word advice", async () => {
		const bucket = makeBucket(() => {
			throw makeParsingFailureError("syntax error - near 'option' (reserved word)");
		});

		const result = await explainQuery({ scope_name: "prices", query: "EXPLAIN SELECT option FROM prices" }, bucket);

		expect(result.isError).toBe(true);
		const text = (result.content[0] as { text: string }).text;
		const parsed = JSON.parse(text) as { _error: { kind: string; advice?: string } };
		expect(parsed._error.kind).toBe("bad-query");
		expect(parsed._error.advice).toContain("backtick reserved-word identifiers");
	});

	test("no-index failure folds in live advisor DDL from a successful advisor call", async () => {
		const bucket = makeBucket((statement: string) => {
			if (statement.startsWith("EXPLAIN")) {
				throw makePlanningFailureError(4000);
			}
			// The internal adviseQuery() call issues the ADVISOR() statement.
			return Promise.resolve({
				rows: Promise.resolve([
					{
						advisor_result: {
							recommended_indexes: [{ index_statement: "CREATE INDEX idx1 ON `archived-orders`(soldToNumber)" }],
						},
					},
				]),
			});
		});

		const result = await explainQuery(
			{ scope_name: "order", query: "SELECT soldToNumber FROM `archived-orders` WHERE soldToNumber = '1'" },
			bucket,
		);

		expect(result.isError).toBe(true);
		const text = (result.content[0] as { text: string }).text;
		const parsed = JSON.parse(text) as { _error: { kind: string; advice?: string } };
		expect(parsed._error.kind).toBe("no-index");
		expect(parsed._error.advice).toContain("CREATE INDEX idx1 ON `archived-orders`(soldToNumber)");
	});

	test("no-index failure still returns clean advice when the internal advisor call throws", async () => {
		const bucket = makeBucket((statement: string) => {
			if (statement.startsWith("EXPLAIN")) {
				throw makePlanningFailureError(4000);
			}
			throw new Error("advisor unavailable");
		});

		const result = await explainQuery(
			{ scope_name: "order", query: "SELECT soldToNumber FROM `archived-orders` WHERE soldToNumber = '1'" },
			bucket,
		);

		expect(result.isError).toBe(true);
		const text = (result.content[0] as { text: string }).text;
		const parsed = JSON.parse(text) as { _error: { kind: string; message: string; advice?: string } };
		expect(parsed._error.kind).toBe("no-index");
		// The original EXPLAIN failure must still surface cleanly -- the advisor's own
		// failure must not mask or replace it.
		expect(parsed._error.message).toContain("Failed to explain query");
		expect(parsed._error.advice).toContain("no queryable index");
	});
});

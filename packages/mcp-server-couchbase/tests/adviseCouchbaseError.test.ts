// tests/adviseCouchbaseError.test.ts
// SIO-1162: the per-kind copy-paste advice mapper populated on Couchbase error envelopes.

import { describe, expect, test } from "bun:test";
import { adviseCouchbaseError } from "../src/lib/adviseCouchbaseError";

describe("adviseCouchbaseError (SIO-1162)", () => {
	test("no-index advises leading-key WHERE / key fetch", () => {
		const advice = adviseCouchbaseError("no-index");
		expect(advice).toBeDefined();
		expect(advice).toContain("first key");
		expect(advice).toContain("capella_get_document_by_id");
	});

	// SIO-1176: production logs showed repeated non-sargable LIKE "%...%" retries.
	test("no-index calls out leading-wildcard LIKE with the prefix alternative", () => {
		const advice = adviseCouchbaseError("no-index");
		expect(advice).toContain('leading-wildcard LIKE ("%...%")');
		expect(advice).toContain('prefix LIKE ("abc%")');
	});

	test("bad-query advises fixing the FROM clause / scope_name", () => {
		const advice = adviseCouchbaseError("bad-query");
		expect(advice).toBeDefined();
		expect(advice).toContain("scope_name");
	});

	test("non-actionable kinds return undefined", () => {
		expect(adviseCouchbaseError("not-found")).toBeUndefined();
		expect(adviseCouchbaseError("auth-denied")).toBeUndefined();
		expect(adviseCouchbaseError("timeout")).toBeUndefined();
		expect(adviseCouchbaseError("unknown")).toBeUndefined();
	});
});

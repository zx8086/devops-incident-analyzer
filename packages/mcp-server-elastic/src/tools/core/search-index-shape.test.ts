// packages/mcp-server-elastic/src/tools/core/search-index-shape.test.ts
import { describe, expect, test } from "bun:test";
import { isConcreteBackingIndexName, NOT_FOUND_WILDCARD_ADVICE, notFoundWildcardAdvice } from "./search-index-shape.ts";

// SIO-1144: a 404 index_not_found only fires on a concrete named index; a data stream / wildcard
// that matches nothing returns 0 hits, not a 404. isConcreteBackingIndexName gates whether the
// not-found envelope carries retry-with-wildcard advice, so a genuinely-absent wildcard still reads
// as a clean absence rather than a "you mistyped the name" nudge.
describe("isConcreteBackingIndexName", () => {
	test("true for the exact backing-index name from the images-v2 incident report", () => {
		expect(isConcreteBackingIndexName("logs-apm.app.myservice-default-2026.07.16-000057")).toBe(true);
	});

	test("true for a dated index with no rollover sequence", () => {
		expect(isConcreteBackingIndexName("logs-kong.prd-eu_shared_services-2026.07.10")).toBe(true);
	});

	test("true for a leading .ds- backing-index name", () => {
		expect(isConcreteBackingIndexName(".ds-logs-apm.app.myservice-default-2026.07.16-000057")).toBe(true);
	});

	test("true for a bare 6-digit rollover suffix", () => {
		expect(isConcreteBackingIndexName("traces-apm-7.17.0-default-000123")).toBe(true);
	});

	test("false for the data-stream name (no date/sequence, no .ds-)", () => {
		expect(isConcreteBackingIndexName("logs-apm.app.myservice-default")).toBe(false);
	});

	test("false for a wildcard error-stream pattern", () => {
		expect(isConcreteBackingIndexName("logs-apm.error-*")).toBe(false);
	});

	test("false for the broad logs-*,logs-apm.* pattern", () => {
		expect(isConcreteBackingIndexName("logs-*,logs-apm.*")).toBe(false);
	});

	test("false when any comma-list member is a wildcard, even if another looks concrete", () => {
		expect(isConcreteBackingIndexName("logs-apm.app.svc-default-2026.07.16-000057,logs-*")).toBe(false);
	});

	test("true only when EVERY comma-list member is concrete", () => {
		expect(isConcreteBackingIndexName("logs-a-2026.07.16-000001,logs-b-2026.07.16-000002")).toBe(true);
	});

	test("false for undefined / empty index", () => {
		expect(isConcreteBackingIndexName(undefined)).toBe(false);
		expect(isConcreteBackingIndexName("")).toBe(false);
	});
});

describe("notFoundWildcardAdvice", () => {
	test("attaches wildcard-retry advice for a concrete backing-index 404", () => {
		const advice = notFoundWildcardAdvice("not-found", "logs-apm.app.myservice-default-2026.07.16-000057");
		expect(advice).toBe(NOT_FOUND_WILDCARD_ADVICE);
		expect(advice).toContain("logs-apm.error-*");
		expect(advice).toContain("data stream");
	});

	test("no advice for a genuinely-absent wildcard (reads as clean absence)", () => {
		expect(notFoundWildcardAdvice("not-found", "logs-apm.error-*")).toBeUndefined();
	});

	test("no advice for a non-not-found kind even on a concrete name", () => {
		expect(notFoundWildcardAdvice("bad-query", "logs-apm.app.svc-default-2026.07.16-000057")).toBeUndefined();
	});
});

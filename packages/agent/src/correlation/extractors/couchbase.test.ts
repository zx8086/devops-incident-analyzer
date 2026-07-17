// packages/agent/src/correlation/extractors/couchbase.test.ts
import { describe, expect, test } from "bun:test";
import type { ResolvedIdentifiers, ToolOutput } from "@devops-agent/shared";
import { collectCouchbaseKeyspaces, extractCouchbaseFindings } from "./couchbase.ts";

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

	test("falls back to flagged unscoped rows when no statement names the focus (SIO-1138)", () => {
		// A slow query often names a bucket/collection, not the focus service. The
		// strict drop used to empty the card; the rows now surface flagged unscoped.
		const out = extractCouchbaseFindings(
			[queries([{ statement: "SELECT * FROM `product_catalog` WHERE k = $1" }])],
			["prices-api-v2-service"],
		);
		expect(out.slowQueries).toHaveLength(1);
		expect(out.unscoped).toBe(true);
	});
});

describe("extractCouchbaseFindings keyspace bridge + unscoped fallback (SIO-1138)", () => {
	const queries = (rows: Array<Record<string, unknown>>): ToolOutput => ({
		toolName: "capella_get_longest_running_queries",
		rawJson: rows,
	});

	test("keeps statements touching a keyspace whose name matches the focus (service -> collection bridge)", () => {
		const out = extractCouchbaseFindings(
			[
				queries([
					{ statement: "SELECT * FROM orders WHERE status = 'OPEN'" },
					{ statement: "SELECT * FROM articles WHERE x = 1" },
				]),
			],
			["prana-order-service"],
			["orders", "styles", "dates"],
		);
		expect(out.slowQueries).toHaveLength(1);
		expect(out.slowQueries?.[0]?.statement).toContain("orders");
		expect(out.unscoped).toBeUndefined();
	});

	test("resolved keyspaces whose names do NOT match the focus never un-scope the card", () => {
		// The resolveIdentifiers scope tree is deliberately unfiltered; only
		// focus-linked keyspace names may bridge. Everything else takes the
		// flagged fallback path.
		const out = extractCouchbaseFindings(
			[queries([{ statement: "SELECT * FROM `styles`.`variant` v" }])],
			["prana-order-service"],
			["styles", "variant", "dates"],
		);
		expect(out.unscoped).toBe(true);
		expect(out.slowQueries).toHaveLength(1);
	});

	test("fallback keeps the top 5 rows in arrival (impact) order", () => {
		const rows = Array.from({ length: 7 }, (_, i) => ({ statement: `SELECT ${i} FROM product_catalog` }));
		const out = extractCouchbaseFindings([queries(rows)], ["prana-order-service"], []);
		expect(out.unscoped).toBe(true);
		expect(out.slowQueries).toHaveLength(5);
		expect(out.slowQueries?.[0]?.statement).toBe("SELECT 0 FROM product_catalog");
	});

	test("fallback excludes system: keyspace statements (analyzer's own introspection)", () => {
		const out = extractCouchbaseFindings(
			[
				queries([
					{ statement: "SELECT * FROM system:completed_requests WHERE node = 'x'" },
					{ statement: "SELECT * FROM product_catalog" },
				]),
			],
			["prana-order-service"],
		);
		expect(out.unscoped).toBe(true);
		expect(out.slowQueries).toHaveLength(1);
		expect(out.slowQueries?.[0]?.statement).toContain("product_catalog");
	});

	test("returns {} when only system: statements would remain for the fallback", () => {
		const out = extractCouchbaseFindings(
			[queries([{ statement: "SELECT ADVISOR($q) FROM system:dual" }])],
			["prices-api-v2-service"],
		);
		expect(out).toEqual({});
	});

	test("collectCouchbaseKeyspaces flattens default-bucket scopes and otherBucketScopes", () => {
		const resolved: ResolvedIdentifiers = {
			resolvedForTurn: 1,
			resolvedForServices: ["prana-order-service"],
			couchbase: {
				scopes: { styles: ["variant", "article"], seasons: ["dates"] },
				otherBucketScopes: { b2c: { pricing: ["prices"] } },
			},
		};
		expect(collectCouchbaseKeyspaces(resolved).sort()).toEqual(
			["article", "dates", "prices", "pricing", "seasons", "styles", "variant"].sort(),
		);
	});

	test("collectCouchbaseKeyspaces returns [] when resolution is absent", () => {
		expect(collectCouchbaseKeyspaces(undefined)).toEqual([]);
	});
});

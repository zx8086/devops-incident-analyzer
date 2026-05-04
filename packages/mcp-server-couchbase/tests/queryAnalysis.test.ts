// tests/queryAnalysis.test.ts
// SIO-667: pure unit tests for the buildQuery extractions in 6 queryAnalysis
// tools and for the assertIdentifier helper. No Couchbase connection needed.

import { describe, expect, test } from "bun:test";
import { assertIdentifier, COUCHBASE_IDENTIFIER_RE } from "../src/lib/identifiers";
import { buildQuery as buildDetailedIndexes } from "../src/tools/queryAnalysis/getDetailedIndexes";
import { buildQuery as buildDocumentTypeExamples } from "../src/tools/queryAnalysis/getDocumentTypeExamples";
import { buildQuery as buildIndexesToDrop } from "../src/tools/queryAnalysis/getIndexesToDrop";
import { buildQuery as buildSystemIndexes } from "../src/tools/queryAnalysis/getSystemIndexes";
import { buildQuery as buildSystemNodes } from "../src/tools/queryAnalysis/getSystemNodes";
import { buildQuery as buildSystemVitals } from "../src/tools/queryAnalysis/getSystemVitals";

const INJECTION_LITERAL = "foo' OR 1=1 --";
const INJECTION_DQ = 'foo" OR 1=1 --';

describe("assertIdentifier", () => {
	test.each(["_default", "documentType", "Type1", "_a_b", "a", "Z9", "_"])("accepts %p", (v) => {
		expect(assertIdentifier(v, "x")).toBe(v);
	});

	test.each([
		"",
		"1abc",
		"a-b",
		"a.b",
		"a;b",
		"a b",
		"a`b",
		"a'b",
		'a"b',
		"a%b",
		"_default; DROP --",
	])("rejects %p", (v) => {
		expect(() => assertIdentifier(v, "x")).toThrow(/Invalid identifier for x/);
	});

	test("regex constant exposed for callers", () => {
		expect(COUCHBASE_IDENTIFIER_RE.test("_default")).toBe(true);
		expect(COUCHBASE_IDENTIFIER_RE.test("a-b")).toBe(false);
	});
});

describe("getDetailedIndexes.buildQuery", () => {
	test("empty input produces no WHERE clause and empty parameters", () => {
		const { query, parameters } = buildDetailedIndexes({});
		expect(query).not.toMatch(/WHERE/);
		expect(parameters).toEqual({});
	});

	test("bucket_name binds as parameter, never spliced", () => {
		const { query, parameters } = buildDetailedIndexes({ bucket_name: INJECTION_LITERAL });
		expect(query).toContain("$bucket_name");
		expect(query).not.toContain(INJECTION_LITERAL);
		expect(parameters.bucket_name).toBe(INJECTION_LITERAL);
	});

	test("scope_name binds as parameter", () => {
		const { query, parameters } = buildDetailedIndexes({ scope_name: INJECTION_LITERAL });
		expect(query).toContain("$scope_name");
		expect(query).not.toContain(INJECTION_LITERAL);
		expect(parameters.scope_name).toBe(INJECTION_LITERAL);
	});

	test("collection_name binds as parameter", () => {
		const { query, parameters } = buildDetailedIndexes({ collection_name: INJECTION_LITERAL });
		expect(query).toContain("$collection_name");
		expect(query).not.toContain(INJECTION_LITERAL);
		expect(parameters.collection_name).toBe(INJECTION_LITERAL);
	});

	test("state binds as parameter", () => {
		const { query, parameters } = buildDetailedIndexes({ state: INJECTION_LITERAL });
		expect(query).toContain("$state");
		expect(query).not.toContain(INJECTION_LITERAL);
		expect(parameters.state).toBe(INJECTION_LITERAL);
	});

	test("index_type binds as parameter", () => {
		const { query, parameters } = buildDetailedIndexes({ index_type: INJECTION_LITERAL });
		expect(query).toContain("$index_type");
		expect(query).not.toContain(INJECTION_LITERAL);
		expect(parameters.index_type).toBe(INJECTION_LITERAL);
	});

	test("all 5 literal filters together produce 5 placeholders + 5 parameters", () => {
		const { query, parameters } = buildDetailedIndexes({
			bucket_name: "b",
			scope_name: "s",
			collection_name: "c",
			state: "online",
			index_type: "GSI",
		});
		expect(query).toContain("$bucket_name");
		expect(query).toContain("$scope_name");
		expect(query).toContain("$collection_name");
		expect(query).toContain("$state");
		expect(query).toContain("$index_type");
		expect(Object.keys(parameters).sort()).toEqual([
			"bucket_name",
			"collection_name",
			"index_type",
			"scope_name",
			"state",
		]);
	});

	test("boolean filters add constant clauses without parameters", () => {
		const { query, parameters } = buildDetailedIndexes({ has_condition: true, is_primary: false });
		expect(query).toContain("t.condition IS NOT NULL");
		expect(query).toContain("(t.is_primary IS MISSING OR t.is_primary = false)");
		expect(parameters).toEqual({});
	});

	test("sort_by enum substitutes correct ORDER BY field", () => {
		expect(buildDetailedIndexes({ sort_by: "name" }).query).toMatch(/ORDER BY\s+t\.name/);
		expect(buildDetailedIndexes({ sort_by: "state" }).query).toMatch(/ORDER BY\s+t\.state/);
		expect(buildDetailedIndexes({ sort_by: "last_scan_time" }).query).toMatch(/ORDER BY\s+t\.metadata\.last_scan_time/);
		expect(buildDetailedIndexes({}).query).toMatch(/ORDER BY\s+t\.keyspace_id, t\.name/);
	});

	test("no /* WHERE_CLAUSES */ or /* ORDER_BY */ marker leaks into output", () => {
		const { query } = buildDetailedIndexes({ bucket_name: "b" });
		expect(query).not.toContain("/* WHERE_CLAUSES */");
		expect(query).not.toContain("/* ORDER_BY */");
	});
});

describe("getIndexesToDrop.buildQuery", () => {
	test("no filter passes through default array literals, empty parameters", () => {
		const { query, parameters } = buildIndexesToDrop({});
		expect(query).toContain('["default", "prices"]');
		expect(parameters).toEqual({});
	});

	test("CSV with injection input is parameterized -- raw value never appears in query", () => {
		// CSV containing a comma still gets split, but every element binds as a placeholder.
		// What matters: no element's raw value leaks into the SQL string.
		const evilA = `evil"]`;
		const evilB = ` DROP --`;
		const { query, parameters } = buildIndexesToDrop({ bucket_filter: `${evilA},${evilB}` });
		expect(query).not.toContain(evilA);
		expect(query).not.toContain(evilB.trim());
		expect(query).toContain("[$b0, $b1]");
		expect(parameters.b0).toBe(evilA);
		expect(parameters.b1).toBe(evilB.trim());
	});

	test("single-element bucket_filter (no comma) binds as $b0 only", () => {
		const evil = "evil' OR 1=1 --";
		const { query, parameters } = buildIndexesToDrop({ bucket_filter: evil });
		expect(query).not.toContain(evil);
		expect(query).toContain("[$b0]");
		expect(parameters).toEqual({ b0: evil });
	});

	test("3-element CSV produces 3 placeholders both inside the inner and outer ANY", () => {
		const { query, parameters } = buildIndexesToDrop({ bucket_filter: "a,b,c" });
		expect(parameters).toEqual({ b0: "a", b1: "b", b2: "c" });
		// Both ANY v IN [...] occurrences (inner sub-SELECT and outer WHERE) get rewritten.
		const matches = query.match(/ANY v IN \[\$b0, \$b1, \$b2\]/g);
		expect(matches?.length).toBe(2);
	});

	test("trailing comma and whitespace are normalized", () => {
		const { query, parameters } = buildIndexesToDrop({ bucket_filter: " a , b , " });
		expect(parameters).toEqual({ b0: "a", b1: "b" });
		expect(query).toContain("[$b0, $b1]");
	});

	test("empty CSV string falls back to base query", () => {
		const { query, parameters } = buildIndexesToDrop({ bucket_filter: "  ,  " });
		expect(parameters).toEqual({});
		expect(query).toContain('["default", "prices"]');
	});
});

describe("getDocumentTypeExamples.buildQuery", () => {
	test("default identifiers pass and produce empty parameters bag", () => {
		const { query, parameters } = buildDocumentTypeExamples({
			scope_name: "_default",
			collection_name: "_default",
			type_field: "documentType",
		});
		expect(parameters).toEqual({});
		// Defaults match the base SQL exactly -- no replacement happens.
		expect(query).toContain("FROM default._default._default");
		expect(query).toContain("d.documentType");
	});

	test("non-default identifiers splice as backtick-wrapped", () => {
		const { query } = buildDocumentTypeExamples({
			scope_name: "myScope",
			collection_name: "myColl",
			type_field: "kind",
		});
		expect(query).toContain("FROM default.`myScope`.`myColl`");
		expect(query).toContain("d.`kind`");
	});

	test("scope_name injection rejected", () => {
		expect(() =>
			buildDocumentTypeExamples({
				scope_name: "foo`; DROP --",
				collection_name: "_default",
				type_field: "documentType",
			}),
		).toThrow(/Invalid identifier for scope_name/);
	});

	test("collection_name injection rejected", () => {
		expect(() =>
			buildDocumentTypeExamples({
				scope_name: "_default",
				collection_name: "foo`; DROP --",
				type_field: "documentType",
			}),
		).toThrow(/Invalid identifier for collection_name/);
	});

	test("type_field injection rejected", () => {
		expect(() =>
			buildDocumentTypeExamples({
				scope_name: "_default",
				collection_name: "_default",
				type_field: "foo`; DROP --",
			}),
		).toThrow(/Invalid identifier for type_field/);
	});
});

describe("getSystemIndexes.buildQuery", () => {
	test("empty input emits include_system constant clause and no parameters", () => {
		const { query, parameters } = buildSystemIndexes({});
		expect(query).toContain("t.`namespace` != 'system'");
		expect(parameters).toEqual({});
	});

	test("bucket_name binds as parameter", () => {
		const { query, parameters } = buildSystemIndexes({ bucket_name: INJECTION_LITERAL });
		expect(query).toContain("$bucket_name");
		expect(query).not.toContain(INJECTION_LITERAL);
		expect(parameters.bucket_name).toBe(INJECTION_LITERAL);
	});

	test("index_type binds as parameter", () => {
		const { query, parameters } = buildSystemIndexes({ index_type: INJECTION_LITERAL });
		expect(query).toContain("$index_type");
		expect(query).not.toContain(INJECTION_LITERAL);
		expect(parameters.index_type).toBe(INJECTION_LITERAL);
	});

	test("include_system: true drops the system-namespace exclusion", () => {
		const { query } = buildSystemIndexes({ include_system: true });
		expect(query).not.toContain("t.`namespace` != 'system'");
	});

	test("inner sub-SELECT WHERE preserved (no collision with outer WHERE)", () => {
		const { query } = buildSystemIndexes({ bucket_name: "b" });
		// The inner sub-SELECT WHERE filtering UPPER(statement) NOT LIKE '...' must remain.
		expect(query).toContain("UPPER(statement) NOT LIKE '% SYSTEM:%'");
		expect(query).toContain("UPPER(statement) NOT LIKE 'CREATE INDEX%'");
	});

	test("no /* WHERE_CLAUSES */ marker leaks into output", () => {
		const { query } = buildSystemIndexes({ bucket_name: "b" });
		expect(query).not.toContain("/* WHERE_CLAUSES */");
	});
});

describe("getSystemNodes.buildQuery", () => {
	test("no filter returns base query and empty parameters", () => {
		const { query, parameters } = buildSystemNodes({});
		expect(query.trim()).toBe("SELECT * FROM system:nodes;");
		expect(parameters).toEqual({});
	});

	test("service_filter binds as parameter", () => {
		const { query, parameters } = buildSystemNodes({ service_filter: INJECTION_DQ });
		expect(query).toContain("$service_filter");
		expect(query).not.toContain(INJECTION_DQ);
		expect(parameters.service_filter).toBe(INJECTION_DQ);
	});
});

describe("getSystemVitals.buildQuery", () => {
	test("no filter returns base query and empty parameters", () => {
		const { query, parameters } = buildSystemVitals({});
		expect(query.trim()).toBe("SELECT * FROM system:vitals;");
		expect(parameters).toEqual({});
	});

	test("node_filter binds as full LIKE pattern in parameters", () => {
		const { query, parameters } = buildSystemVitals({ node_filter: INJECTION_DQ });
		expect(query).toContain("$node_pattern");
		expect(query).not.toContain(INJECTION_DQ);
		expect(parameters.node_pattern).toBe(`%${INJECTION_DQ}%`);
	});
});

// tests/queryAnalysis.test.ts
// SIO-667 + SIO-668: pure unit tests for the buildQuery extractions across 9
// queryAnalysis tools and for the assertIdentifier helper. No Couchbase
// connection needed.

import { describe, expect, test } from "bun:test";
import { assertIdentifier, COUCHBASE_IDENTIFIER_RE } from "../src/lib/identifiers";
import { sqlppParser } from "../src/lib/sqlppParser";
import { buildExplainStatement } from "../src/tools/explainSqlPlusPlusQuery";
import { buildQuery as buildCompletedRequests } from "../src/tools/queryAnalysis/getCompletedRequests";
import { buildQuery as buildDetailedIndexes } from "../src/tools/queryAnalysis/getDetailedIndexes";
import { buildQuery as buildDetailedPreparedStatements } from "../src/tools/queryAnalysis/getDetailedPreparedStatements";
import { buildQuery as buildDocumentTypeExamples } from "../src/tools/queryAnalysis/getDocumentTypeExamples";
import { buildQuery as buildFatalRequests } from "../src/tools/queryAnalysis/getFatalRequests";
import { buildQuery as buildIndexAdvisor, extractAdvisorSections } from "../src/tools/queryAnalysis/getIndexAdvisor";
import { buildQuery as buildIndexesToDrop } from "../src/tools/queryAnalysis/getIndexesToDrop";
import { buildQuery as buildLowSelectivity } from "../src/tools/queryAnalysis/getLowSelectivityQueries";
import { buildQuery as buildMostExpensiveQueries } from "../src/tools/queryAnalysis/getMostExpensiveQueries";
import { buildQuery as buildNonCovering } from "../src/tools/queryAnalysis/getNonCoveringIndexQueries";
import { buildQuery as buildSystemIndexes } from "../src/tools/queryAnalysis/getSystemIndexes";
import { buildQuery as buildSystemNodes } from "../src/tools/queryAnalysis/getSystemNodes";
import { buildQuery as buildSystemVitals } from "../src/tools/queryAnalysis/getSystemVitals";

const INJECTION_LITERAL = "foo' OR 1=1 --";
const INJECTION_DQ = 'foo" OR 1=1 --';

describe("assertIdentifier", () => {
	// Hyphens/percent are legal in Couchbase scope/collection names (e.g. archived-orders)
	// and safe here because every consumer splices the value backtick-wrapped.
	test.each([
		"_default",
		"documentType",
		"Type1",
		"_a_b",
		"a",
		"Z9",
		"_",
		"a-b",
		"archived-orders",
		"archived-order-items",
		"a%b",
		"1abc",
	])("accepts %p", (v) => {
		expect(assertIdentifier(v, "x")).toBe(v);
	});

	test.each(["", "-abc", "%abc", "a.b", "a;b", "a b", "a`b", "a'b", 'a"b', "_default; DROP --"])("rejects %p", (v) => {
		expect(() => assertIdentifier(v, "x")).toThrow(/Invalid identifier for x/);
	});

	test("regex constant exposed for callers", () => {
		expect(COUCHBASE_IDENTIFIER_RE.test("_default")).toBe(true);
		expect(COUCHBASE_IDENTIFIER_RE.test("archived-orders")).toBe(true);
		expect(COUCHBASE_IDENTIFIER_RE.test("a`b")).toBe(false);
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

	test("index_type binds as parameter with `using` backtick-escaped (reserved word)", () => {
		const { query, parameters } = buildDetailedIndexes({ index_type: INJECTION_LITERAL });
		expect(query).toContain("LOWER(t.`using`) = LOWER($index_type)");
		expect(query).not.toMatch(/t\.using\s/);
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

	test("hyphenated collection names are accepted and splice backtick-wrapped", () => {
		const { query } = buildDocumentTypeExamples({
			scope_name: "order",
			collection_name: "archived-orders",
			type_field: "orderType",
		});
		expect(query).toContain("FROM default.`order`.`archived-orders`");
		expect(query).toContain("d.`orderType`");
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

	test("index_type binds as parameter with `using` backtick-escaped (reserved word)", () => {
		const { query, parameters } = buildSystemIndexes({ index_type: INJECTION_LITERAL });
		expect(query).toContain("LOWER(t.`using`) = LOWER($index_type)");
		expect(query).not.toMatch(/t\.using\s/);
		expect(query).not.toContain(INJECTION_LITERAL);
		expect(parameters.index_type).toBe(INJECTION_LITERAL);
	});

	test("include_system: true drops the system-namespace exclusion", () => {
		const { query } = buildSystemIndexes({ include_system: true });
		expect(query).not.toContain("t.`namespace` != 'system'");
	});

	test("total_count is a WITH binding evaluated once, no statement column (SIO-1162)", () => {
		const { query } = buildSystemIndexes({ bucket_name: "b" });
		// SIO-1162: the count must be a plain catalog count (system:indexes has no `statement`
		// column). It now lives in a WITH binding so it evaluates once instead of per row.
		expect(query).toContain("WITH total AS (SELECT RAW COUNT(*) FROM system:indexes)");
		expect(query).toContain("total[0] AS total_count");
		expect(query).not.toMatch(/statement/i);
		// The outer WHERE (system-namespace exclusion) still splices into the marker, not the
		// inner sub-SELECT -- the bucket_name binding and namespace clause remain on the outer t.
		expect(query).toContain("t.`namespace` != 'system'");
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

// SIO-668: 3 leftover queryAnalysis tools that splice user input into SQL++.

describe("getDetailedPreparedStatements.buildQuery", () => {
	test("empty input produces no WHERE clause and empty parameters", () => {
		const { query, parameters } = buildDetailedPreparedStatements({});
		expect(query).not.toMatch(/WHERE/);
		expect(parameters).toEqual({});
	});

	test("node_filter binds as full LIKE pattern in $node_pattern", () => {
		const evil = 'foo"; DROP --';
		const { query, parameters } = buildDetailedPreparedStatements({ node_filter: evil });
		expect(query).toContain("$node_pattern");
		expect(query).toContain("node LIKE $node_pattern");
		expect(query).not.toContain(evil);
		expect(parameters.node_pattern).toBe(`%${evil}%`);
	});

	test("query_pattern binds as full LIKE pattern in $query_pattern_like", () => {
		const evil = "SELECT'; DROP --";
		const { query, parameters } = buildDetailedPreparedStatements({ query_pattern: evil });
		expect(query).toContain("$query_pattern_like");
		expect(query).toContain("statement LIKE $query_pattern_like");
		expect(query).not.toContain(evil);
		expect(parameters.query_pattern_like).toBe(`%${evil}%`);
	});

	test("both filters together produce 2 placeholders + 2 parameters", () => {
		const { query, parameters } = buildDetailedPreparedStatements({
			node_filter: "n1",
			query_pattern: "SELECT",
		});
		expect(query).toContain("$node_pattern");
		expect(query).toContain("$query_pattern_like");
		expect(query).toContain("AND");
		expect(Object.keys(parameters).sort()).toEqual(["node_pattern", "query_pattern_like"]);
	});

	test("limit is spliced into the query (numeric, Zod-validated)", () => {
		const { query } = buildDetailedPreparedStatements({ limit: 25 });
		expect(query).toMatch(/LIMIT 25/);
	});

	test("WHERE is inserted before ORDER BY when both filters and limit are present", () => {
		const { query } = buildDetailedPreparedStatements({ node_filter: "x", limit: 5 });
		const wherePos = query.indexOf("WHERE");
		const orderPos = query.indexOf("ORDER BY");
		expect(wherePos).toBeGreaterThanOrEqual(0);
		expect(wherePos).toBeLessThan(orderPos);
	});
});

describe("getCompletedRequests.buildQuery", () => {
	test("empty input applies the default LIMIT (full 8-week scan+sort otherwise)", () => {
		const { query, parameters } = buildCompletedRequests({});
		expect(parameters).toEqual({});
		expect(query).toMatch(/LIMIT 50;?\s*$/);
	});

	test("explicit limit overrides the default", () => {
		const { query } = buildCompletedRequests({ limit: 7 });
		expect(query).toMatch(/LIMIT 7;?\s*$/);
		expect(query).not.toMatch(/LIMIT 50/);
	});

	test("status: 'fatal' binds as $status -- raw value not spliced", () => {
		const { query, parameters } = buildCompletedRequests({ status: "fatal" });
		expect(query).toContain("$status");
		expect(query).toContain("state = $status");
		// The literal `state = 'fatal'` form must NOT appear -- if it did the splice would still be live.
		expect(query).not.toContain("state = 'fatal'");
		expect(parameters.status).toBe("fatal");
	});

	test("status: 'all' skips the filter entirely (pre-SIO-668 behavior preserved)", () => {
		const { query, parameters } = buildCompletedRequests({ status: "all" });
		expect(query).not.toContain("$status");
		expect(parameters).toEqual({});
	});

	test("period: 'quarter' rewrites DATE_ADD_STR to -3 month", () => {
		const { query } = buildCompletedRequests({ period: "quarter" });
		expect(query).toContain("DATE_ADD_STR(NOW_STR(), -3, 'month')");
	});

	test("period: 'day' rewrites DATE_ADD_STR to -1 day", () => {
		const { query } = buildCompletedRequests({ period: "day" });
		expect(query).toContain("DATE_ADD_STR(NOW_STR(), -1, 'day')");
	});

	test("status + period + limit compose correctly", () => {
		const { query, parameters } = buildCompletedRequests({ status: "success", period: "week", limit: 100 });
		expect(query).toContain("$status");
		expect(query).toContain("DATE_ADD_STR(NOW_STR(), -1, 'week')");
		expect(query).toMatch(/LIMIT 100/);
		expect(parameters.status).toBe("success");
	});
});

describe("getFatalRequests.buildQuery", () => {
	test("empty input applies the default LIMIT", () => {
		const { query } = buildFatalRequests({});
		expect(query).toMatch(/ORDER BY requestTime DESC LIMIT 50;/);
	});

	test("explicit limit overrides the default", () => {
		const { query } = buildFatalRequests({ limit: 5 });
		expect(query).toMatch(/ORDER BY requestTime DESC LIMIT 5;/);
		expect(query).not.toMatch(/LIMIT 50/);
	});

	test("period: 'day' rewrites DATE_ADD_STR", () => {
		const { query } = buildFatalRequests({ period: "day" });
		expect(query).toContain("DATE_ADD_STR(NOW_STR(), -1, 'day')");
	});
});

describe("getMostExpensiveQueries.buildQuery", () => {
	test("empty input returns base query with empty parameters", () => {
		const { parameters } = buildMostExpensiveQueries({});
		expect(parameters).toEqual({});
	});

	test("no template-literal markers leak into output", () => {
		const { query } = buildMostExpensiveQueries({ period: "day", limit: 10 });
		// `${` should never appear -- it would mean a JS template never resolved.
		expect(query).not.toContain("${");
	});

	// SIO-1175: the query must never scan the full completed_requests keyspace.
	test("default query carries the 8-week window and DEFAULT_ANALYSIS_LIMIT", () => {
		const { query } = buildMostExpensiveQueries({});
		expect(query).toContain("requestTime >= DATE_ADD_STR(NOW_STR(), -8, 'week')");
		expect(query).toMatch(/LIMIT 50;/);
	});

	test("period: 'day' REPLACES the default window (single requestTime predicate)", () => {
		const { query } = buildMostExpensiveQueries({ period: "day" });
		expect(query).toContain("requestTime >= DATE_ADD_STR(NOW_STR(), -1, 'day')");
		expect(query.match(/requestTime >=/g)).toHaveLength(1);
	});

	test("period: 'month' substitutes constant clause", () => {
		const { query } = buildMostExpensiveQueries({ period: "month" });
		expect(query).toContain("requestTime >= DATE_ADD_STR(NOW_STR(), -1, 'month')");
		expect(query.match(/requestTime >=/g)).toHaveLength(1);
	});

	test("explicit limit overrides the default (single LIMIT clause)", () => {
		const { query } = buildMostExpensiveQueries({ limit: 10 });
		expect(query).toMatch(/LIMIT 10;/);
		expect(query.match(/LIMIT \d+/g)).toHaveLength(1);
	});

	// SIO-1175: duration strings are converted once per row via LET, not once per
	// aggregate. A regression back to inline-per-aggregate conversion would push
	// the STR_TO_DURATION count far above the LET variable count.
	test("duration conversions are LET-based, pct_ columns dropped", () => {
		const { query } = buildMostExpensiveQueries({});
		expect(query).toContain("LET svc = STR_TO_DURATION(serviceTime)");
		expect(query.match(/STR_TO_DURATION/g)).toHaveLength(6);
		expect(query).not.toContain("pct_");
	});

	test("parameters bag is always empty (no user literals to bind)", () => {
		expect(buildMostExpensiveQueries({}).parameters).toEqual({});
		expect(buildMostExpensiveQueries({ period: "week", limit: 10 }).parameters).toEqual({});
	});
});

// SIO-1107: covering-index / selectivity detectors + advisor + EXPLAIN helpers.

describe("getNonCoveringIndexQueries.buildQuery (SIO-1107)", () => {
	test("default query filters on indexScan AND fetch phases, no LIMIT, empty parameters", () => {
		const { query, parameters } = buildNonCovering({});
		expect(query).toContain("phaseCounts.indexScan IS NOT MISSING");
		expect(query).toContain("phaseCounts['fetch'] IS NOT MISSING");
		expect(query).not.toMatch(/LIMIT/);
		expect(parameters).toEqual({});
	});

	test("limit splices LIMIT N at the end", () => {
		const { query } = buildNonCovering({ limit: 5 });
		expect(query).toMatch(/LIMIT 5;$/);
	});

	test("zero/negative limit is ignored", () => {
		expect(buildNonCovering({ limit: 0 }).query).not.toMatch(/LIMIT/);
		expect(buildNonCovering({ limit: -3 }).query).not.toMatch(/LIMIT/);
	});
});

describe("getLowSelectivityQueries.buildQuery (SIO-1107)", () => {
	test("default query compares indexScan to resultCount, no LIMIT, empty parameters", () => {
		const { query, parameters } = buildLowSelectivity({});
		expect(query).toContain("phaseCounts.indexScan > resultCount");
		expect(query).toContain("avgScanResultGap");
		expect(query).not.toMatch(/LIMIT/);
		expect(parameters).toEqual({});
	});

	test("limit splices LIMIT N at the end", () => {
		const { query } = buildLowSelectivity({ limit: 7 });
		expect(query).toMatch(/LIMIT 7;$/);
	});
});

describe("getIndexAdvisor.buildQuery (SIO-1107)", () => {
	test("analyzed statement binds as $advise_statement, never spliced", () => {
		const { query, parameters } = buildIndexAdvisor({ query: INJECTION_LITERAL });
		expect(query).toContain("ADVISOR($advise_statement)");
		expect(query).not.toContain(INJECTION_LITERAL);
		expect(parameters.advise_statement).toBe(INJECTION_LITERAL);
	});
});

describe("extractAdvisorSections (SIO-1107)", () => {
	test("classifies index_statement entries by current/recommended/covering ancestors", () => {
		const rows = [
			{
				advisor_result: {
					adviseinfo: {
						current_used_indexes: [{ index_statement: "CREATE PRIMARY INDEX ON dates" }],
						recommended_indexes: {
							indexes: [{ index_statement: "CREATE INDEX idx_fms ON dates(styleSeasonCodeFms)" }],
							covering_indexes: [{ index_statement: "CREATE INDEX idx_cov ON dates(a, b)" }],
						},
					},
				},
			},
		];
		const sections = extractAdvisorSections(rows);
		expect(sections.current).toEqual(["CREATE PRIMARY INDEX ON dates"]);
		expect(sections.recommended).toEqual(["CREATE INDEX idx_fms ON dates(styleSeasonCodeFms)"]);
		expect(sections.covering).toEqual(["CREATE INDEX idx_cov ON dates(a, b)"]);
	});

	test("garbage / empty input yields empty sections without throwing", () => {
		expect(extractAdvisorSections(null)).toEqual({ current: [], recommended: [], covering: [] });
		expect(extractAdvisorSections([{ unrelated: 1 }])).toEqual({ current: [], recommended: [], covering: [] });
		expect(extractAdvisorSections("string")).toEqual({ current: [], recommended: [], covering: [] });
	});

	test("dedupes repeated statements", () => {
		const rows = [{ recommended_indexes: { indexes: [{ index_statement: "X" }, { index_statement: "X" }] } }];
		expect(extractAdvisorSections(rows).recommended).toEqual(["X"]);
	});

	// Validated against the LIVE Capella ADVISOR shape: current_used_indexes entries
	// carry the DDL under `index` (not `index_statement`); a bare `index` NAME (e.g.
	// an IndexScan operator echo) must NOT be classified as a statement.
	test("live shape: current_used_indexes entries carry DDL under `index`", () => {
		const rows = [
			{
				advisor_result: {
					current_used_indexes: [{ index: "CREATE INDEX idx_sales ON `default`:`default`.`seasons`.`dates`(a)" }],
					recommended_indexes: { indexes: [{ index_statement: "CREATE INDEX idx_reco ON dates(b)" }] },
				},
			},
		];
		const sections = extractAdvisorSections(rows);
		expect(sections.current).toEqual(["CREATE INDEX idx_sales ON `default`:`default`.`seasons`.`dates`(a)"]);
		expect(sections.recommended).toEqual(["CREATE INDEX idx_reco ON dates(b)"]);
	});

	test("a non-DDL `index` field (index name) is not classified", () => {
		const sections = extractAdvisorSections([{ current_used_indexes: [{ index: "idx_name_only" }] }]);
		expect(sections).toEqual({ current: [], recommended: [], covering: [] });
	});
});

describe("buildExplainStatement (SIO-1107)", () => {
	test("prepends EXPLAIN to a plain statement", () => {
		expect(buildExplainStatement("SELECT 1")).toBe("EXPLAIN SELECT 1");
	});

	test("idempotent when EXPLAIN is already present (any case)", () => {
		expect(buildExplainStatement("explain SELECT 1")).toBe("EXPLAIN SELECT 1");
		expect(buildExplainStatement("EXPLAIN  SELECT 1")).toBe("EXPLAIN SELECT 1");
	});

	test("strips a trailing semicolon before wrapping", () => {
		expect(buildExplainStatement("SELECT 1; ")).toBe("EXPLAIN SELECT 1");
	});
});

// SIO-1107: lock in the first-token gate assumption -- EXPLAIN / SELECT ADVISOR /
// INFER must pass readOnlyQueryMode; mutations must still be caught.
describe("sqlppParser read-only gate regression (SIO-1107)", () => {
	test.each([
		"EXPLAIN SELECT * FROM c",
		"SELECT ADVISOR('SELECT 1') AS r",
		"INFER `c`",
	])("%p passes modifiesData and modifiesStructure", (q) => {
		const parsed = sqlppParser.parse(q);
		expect(sqlppParser.modifiesData(parsed)).toBe(false);
		expect(sqlppParser.modifiesStructure(parsed)).toBe(false);
	});

	test.each(["DELETE FROM c", "UPSERT INTO c VALUES ('k', {})"])("%p is caught as data modification", (q) => {
		const parsed = sqlppParser.parse(q);
		expect(sqlppParser.modifiesData(parsed)).toBe(true);
	});

	test("CREATE INDEX is caught as structure modification", () => {
		const parsed = sqlppParser.parse("CREATE INDEX idx ON c(a)");
		expect(sqlppParser.modifiesStructure(parsed)).toBe(true);
	});
});

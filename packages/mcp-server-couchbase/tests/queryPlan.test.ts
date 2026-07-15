// tests/queryPlan.test.ts
// SIO-1107: pure unit tests for the EXPLAIN plan evaluator. No Couchbase connection.

import { describe, expect, test } from "bun:test";
import { collectOperators, evaluateQueryPlan, formatPlanFindings } from "../src/lib/queryPlan";

const PRIMARY_SCAN_PLAN = {
	"#operator": "Sequence",
	"~children": [
		{ "#operator": "PrimaryScan3", keyspace: "dates" },
		{ "#operator": "Fetch", keyspace: "dates" },
	],
};

const NON_COVERING_PLAN = {
	"#operator": "Sequence",
	"~children": [
		{ "#operator": "IndexScan3", index: "idx_fms", keyspace: "dates" },
		{ "#operator": "Fetch", keyspace: "dates" },
	],
};

const COVERING_PLAN = {
	"#operator": "Sequence",
	"~children": [{ "#operator": "IndexScan3", index: "idx_cov", keyspace: "dates", covers: ["cover ((`d`.`a`))"] }],
};

describe("collectOperators", () => {
	test("walks nested child slots and arrays", () => {
		const ops = collectOperators(PRIMARY_SCAN_PLAN);
		expect(ops.map((o) => o["#operator"])).toEqual(["Sequence", "PrimaryScan3", "Fetch"]);
	});

	test("survives circular references without hanging", () => {
		const a: Record<string, unknown> = {};
		a.self = a;
		expect(collectOperators(a)).toEqual([]);
	});

	test("non-object input yields no operators", () => {
		expect(collectOperators(null)).toEqual([]);
		expect(collectOperators("text")).toEqual([]);
	});
});

describe("evaluateQueryPlan", () => {
	test("primary scan produces a warning naming the keyspace", () => {
		const findings = evaluateQueryPlan(PRIMARY_SCAN_PLAN);
		const warning = findings.find((f) => f.severity === "warning");
		expect(warning).toBeDefined();
		expect(warning?.message).toMatch(/primary scan/i);
		expect(warning?.message).toContain("dates");
	});

	test("index scan + fetch produces a non-covering warning", () => {
		const findings = evaluateQueryPlan(NON_COVERING_PLAN);
		expect(findings.some((f) => f.severity === "warning" && /does NOT cover/.test(f.message))).toBe(true);
		expect(findings.some((f) => f.message.includes("idx_fms"))).toBe(true);
	});

	test("covering index scan reports covering info and no non-covering warning", () => {
		const findings = evaluateQueryPlan(COVERING_PLAN);
		expect(findings.some((f) => /covering/.test(f.message))).toBe(true);
		expect(findings.some((f) => /does NOT cover/.test(f.message))).toBe(false);
	});

	test("intersect scan produces a composite-index hint", () => {
		const plan = {
			"#operator": "IntersectScan",
			scans: [
				{ "#operator": "IndexScan3", index: "a", keyspace: "k" },
				{ "#operator": "IndexScan3", index: "b", keyspace: "k" },
			],
		};
		const findings = evaluateQueryPlan(plan);
		expect(findings.some((f) => /composite index/.test(f.message))).toBe(true);
	});

	test("garbage plan yields the no-operators info finding, never throws", () => {
		const findings = evaluateQueryPlan(null);
		expect(findings).toHaveLength(1);
		expect(findings[0]?.severity).toBe("info");
		expect(findings[0]?.message).toMatch(/No plan operators/);
	});
});

describe("formatPlanFindings", () => {
	test("renders severity-tagged bullet lines", () => {
		const text = formatPlanFindings([
			{ severity: "warning", message: "w" },
			{ severity: "info", message: "i" },
		]);
		expect(text).toBe("- [WARNING] w\n- [INFO] i");
	});
});

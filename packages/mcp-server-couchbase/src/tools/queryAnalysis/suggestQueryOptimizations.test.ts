// mcp-server-couchbase/src/tools/queryAnalysis/suggestQueryOptimizations.test.ts
//
// SIO-1058: the covering-index suggestion previously emitted `... (keys) INCLUDE (cols)`, which is
// SQL Server syntax -- Couchbase GSI has no INCLUDE covering clause (only INCLUDE MISSING on the
// leading key). Copying it into a report shipped DDL that errors on apply. The correct form appends
// projected fields as trailing index keys, matching the live cluster's own
// idx_article_required_fields_covered. These tests pin the valid form.
import { describe, expect, test } from "bun:test";
import { buildCoveringIndexDdl } from "./suggestQueryOptimizations.ts";

describe("buildCoveringIndexDdl", () => {
	test("appends projected fields as trailing index keys (no INCLUDE clause)", () => {
		const ddl = buildCoveringIndexDdl(
			"default",
			"styles",
			"article",
			["articleNo", "salesStatusCodes.INCK", "salesStatusCodes.CK07"],
			["mainSize", "createdOn", "modifiedOn"],
		);
		expect(ddl).toBe(
			"CREATE INDEX idx_covering ON `default`.`styles`.`article`(articleNo, salesStatusCodes.INCK, salesStatusCodes.CK07, mainSize, createdOn, modifiedOn);",
		);
	});

	test("never emits the invalid `INCLUDE (` covering clause", () => {
		const ddl = buildCoveringIndexDdl("b", "s", "c", ["k1"], ["p1", "p2"]);
		expect(ddl).not.toContain("INCLUDE (");
		expect(ddl).not.toContain("INCLUDE(");
	});

	test("preserves predicate-then-projected key order", () => {
		const ddl = buildCoveringIndexDdl("b", "s", "c", ["a", "b"], ["c", "d"]);
		expect(ddl).toContain("(a, b, c, d)");
	});
});

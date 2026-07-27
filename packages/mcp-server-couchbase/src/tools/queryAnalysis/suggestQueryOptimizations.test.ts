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

	// SIO-1243: the caller's dedupe is an exact case-sensitive Array.includes across two
	// differently-derived string sets, so an overlapping projected field slipped through and
	// produced a duplicate index key -- which Couchbase rejects.
	describe("duplicate index keys (SIO-1243)", () => {
		test("drops a projected field that repeats a leading index key", () => {
			const ddl = buildCoveringIndexDdl(
				"b",
				"s",
				"c",
				["salesOrganizationCode", "articleType"],
				["styleSeasonCodeFms", "documentUpdatedBy", "articleType"],
			);
			expect(ddl).toBe(
				"CREATE INDEX idx_covering ON `b`.`s`.`c`(salesOrganizationCode, articleType, styleSeasonCodeFms, documentUpdatedBy);",
			);
		});

		test("collapses backtick- and case-divergent repeats the caller's filter misses", () => {
			const ddl = buildCoveringIndexDdl("b", "s", "c", ["status"], ["`status`", "Status", "other"]);
			expect(ddl).toBe("CREATE INDEX idx_covering ON `b`.`s`.`c`(status, other);");
		});

		test("deduplicates coveringFields against itself", () => {
			const ddl = buildCoveringIndexDdl("b", "s", "c", ["a"], ["b", "b"]);
			expect(ddl).toBe("CREATE INDEX idx_covering ON `b`.`s`.`c`(a, b);");
		});

		test("a list with no repeats is unchanged", () => {
			const ddl = buildCoveringIndexDdl("b", "s", "c", ["a", "b"], ["c", "d"]);
			expect(ddl).toBe("CREATE INDEX idx_covering ON `b`.`s`.`c`(a, b, c, d);");
		});
	});
});

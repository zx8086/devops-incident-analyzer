// agent/src/ddl-sanitize.test.ts

import { describe, expect, test } from "bun:test";
import { dedupeCreateIndexKeys, looksLikeKeyList, normalizeDdl } from "./ddl-sanitize.ts";

// SIO-1243: the production statement, genericized. `articleType` appears at position 2 and
// again as the final key -- Couchbase rejects a duplicate index key.
const PRODUCTION_DDL = `CREATE INDEX idx_dates_covering ON \`default\`.\`seasons\`.\`dates\`(
  \`salesOrganizationCode\`,
  \`articleType\`,
  \`styleSeasonCodeFms\`,
  \`documentUpdatedBy\`,
  \`articleType\`
)`;

describe("dedupeCreateIndexKeys", () => {
	test("removes the production duplicate key and reports it", () => {
		const { text, removed } = dedupeCreateIndexKeys(PRODUCTION_DDL);
		expect(removed).toEqual(["articletype"]);
		// Exactly one surviving occurrence, in its FIRST position.
		expect(text.match(/articleType/g)).toHaveLength(1);
		expect(text.indexOf("articleType")).toBeLessThan(text.indexOf("styleSeasonCodeFms"));
		expect(text).not.toMatch(/documentUpdatedBy`,\s*`articleType/);
	});

	test("preserves first-occurrence order, original spelling and multi-line layout", () => {
		const { text } = dedupeCreateIndexKeys(PRODUCTION_DDL);
		expect(text).toBe(`CREATE INDEX idx_dates_covering ON \`default\`.\`seasons\`.\`dates\`(
  \`salesOrganizationCode\`,
  \`articleType\`,
  \`styleSeasonCodeFms\`,
  \`documentUpdatedBy\`
)`);
	});

	test("a statement with no duplicates is returned byte-identical", () => {
		const clean = "CREATE INDEX idx_a ON `b`.`s`.`c`(`one`, `two`, `three`);";
		const { text, removed } = dedupeCreateIndexKeys(clean);
		expect(text).toBe(clean);
		expect(removed).toEqual([]);
	});

	// Backticks are quoting, not identity; unquoted N1QL identifiers are case-insensitive.
	test("collapses backtick and case variants of the same key", () => {
		const { text, removed } = dedupeCreateIndexKeys("CREATE INDEX i ON `b`.`s`.`c`(`status`, status, STATUS);");
		expect(removed).toEqual(["status", "status"]);
		expect(text).toBe("CREATE INDEX i ON `b`.`s`.`c`(`status`);");
	});

	// Collapsing these would change index semantics, so they must NOT be treated as duplicates.
	test("does not collapse keys whose full expression differs (DESC / INCLUDE MISSING)", () => {
		const desc = "CREATE INDEX i ON `b`.`s`.`c`(`a`, `a` DESC);";
		expect(dedupeCreateIndexKeys(desc)).toEqual({ text: desc, removed: [] });
		const missing = "CREATE INDEX i ON `b`.`s`.`c`(`a` INCLUDE MISSING, `a`);";
		expect(dedupeCreateIndexKeys(missing)).toEqual({ text: missing, removed: [] });
	});

	test("leaves non-DDL prose untouched", () => {
		const prose = "We should CREATE INDEX coverage for this collection (not production) before peak.";
		expect(dedupeCreateIndexKeys(prose)).toEqual({ text: prose, removed: [] });
	});

	// CREATE_INDEX_SHAPE_RE's `[^)]*` truncates at the first ")", so a functional key would give
	// a partial capture. Rewriting from it would corrupt the statement -- skip instead.
	test("skips a key list containing a nested paren rather than mangling it", () => {
		const fn = "CREATE INDEX i ON `b`.`s`.`c`(LOWER(`name`), `name`, LOWER(`name`));";
		expect(dedupeCreateIndexKeys(fn)).toEqual({ text: fn, removed: [] });
	});

	test("handles multiple statements in one string independently", () => {
		const both = ["CREATE INDEX i1 ON `b`.`s`.`c`(`a`, `a`);", "", "CREATE INDEX i2 ON `b`.`s`.`d`(`x`, `y`);"].join(
			"\n",
		);
		const { text, removed } = dedupeCreateIndexKeys(both);
		expect(removed).toEqual(["a"]);
		expect(text).toContain("CREATE INDEX i1 ON `b`.`s`.`c`(`a`);");
		expect(text).toContain("CREATE INDEX i2 ON `b`.`s`.`d`(`x`, `y`);");
	});

	test("preserves a trailing WHERE clause after the key list", () => {
		const { text } = dedupeCreateIndexKeys("CREATE INDEX i ON `b`.`s`.`c`(`a`, `a`) WHERE `a` IS NOT NULL;");
		expect(text).toBe("CREATE INDEX i ON `b`.`s`.`c`(`a`) WHERE `a` IS NOT NULL;");
	});

	test("dedupes DDL embedded in a fenced block inside a larger recommendation string", () => {
		const item = [
			"Escalate: add a covering index (requires human approval).",
			"",
			"```sql",
			PRODUCTION_DDL,
			"```",
		].join("\n");
		const { text, removed } = dedupeCreateIndexKeys(item);
		expect(removed).toEqual(["articletype"]);
		expect(text).toStartWith("Escalate: add a covering index (requires human approval).");
		expect(text).toContain("```sql");
		expect(text.match(/articleType/g)).toHaveLength(1);
	});

	// The fast-path guard must match CREATE_INDEX_RE's /i, or mixed-case DDL skips the sanitizer.
	test("dedupes mixed-case DDL", () => {
		const { text, removed } = dedupeCreateIndexKeys("Create Index i On `b`.`s`.`c`(`a`, `a`);");
		expect(removed).toEqual(["a"]);
		expect(text).toBe("Create Index i On `b`.`s`.`c`(`a`);");
	});

	test("is idempotent", () => {
		const once = dedupeCreateIndexKeys(PRODUCTION_DDL).text;
		expect(dedupeCreateIndexKeys(once)).toEqual({ text: once, removed: [] });
	});
});

// Moved from aggregator.ts with SIO-1243 -- pinned here so the shared definitions cannot drift.
describe("moved helpers keep their aggregator semantics", () => {
	test("looksLikeKeyList accepts real key lists and rejects prose", () => {
		expect(looksLikeKeyList("`a`, `b`")).toBe(true);
		expect(looksLikeKeyList("single")).toBe(true);
		expect(looksLikeKeyList("not production")).toBe(false);
		expect(looksLikeKeyList("")).toBe(false);
	});

	test("normalizeDdl is whitespace- and trailing-semicolon-insensitive", () => {
		expect(normalizeDdl("CREATE  INDEX\n i ON b(a);")).toBe("CREATE INDEX i ON b(a)");
	});
});

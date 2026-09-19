// tests/sqlppReadOnlyGate.test.ts
//
// SIO-1822: the read-only gate is an ALLOW-LIST -- a statement head that is not provably
// a read is refused. The deny-list it replaced let any unlisted statement class through,
// which was not theoretical: FLUSH COLLECTION and TRUNCATE COLLECTION both empty a
// collection and both passed the old gate.
//
// The expectations below are derived from the query service grammar (couchbase/query
// parser/n1ql/n1ql.y, rule `stmt_body`), not from memory. Read paths there are
// advise | explain | prepare | execute | explain_function | select_stmt | infer;
// resolving each class to its leading terminal produces the allowed set, with PREPARE and
// EXECUTE deliberately excluded because they run statements this gate cannot inspect.

import { describe, expect, test } from "bun:test";
import { SQLPPParserImpl } from "../src/lib/sqlppParser";

const parser = new SQLPPParserImpl();

const isRefused = (query: string): boolean => {
	const parsed = parser.parse(query);
	return parser.modifiesData(parsed) || parser.modifiesStructure(parsed);
};

describe("SQL++ read-only gate (SIO-1822 allow-list)", () => {
	describe("reads pass", () => {
		test.each([
			["plain select", "SELECT * FROM `airline` LIMIT 1"],
			// grammar: subselect -> from_select, so a SELECT may begin with FROM
			["FROM-first select", "FROM `airline` SELECT name"],
			["WITH clause", "WITH x AS (SELECT 1) SELECT * FROM x"],
			["parenthesised fullselect", "(SELECT 1)"],
			["INFER", "INFER `airline`"],
			// SIO-1107: EXPLAIN/ADVISE plan a statement and never run it
			["EXPLAIN of a mutation", "EXPLAIN UPDATE `a` SET x=1"],
			["ADVISE", "ADVISE SELECT 1"],
		])("allows %s", (_label, query) => {
			expect(isRefused(query)).toBe(false);
		});

		// SIO-1813 ruling, preserved: these mutate nothing themselves, and every DML inside a
		// transaction arrives as its own request through this same gate.
		test.each([
			["BEGIN TRANSACTION"],
			["COMMIT"],
			["ROLLBACK"],
			["SAVEPOINT s1"],
			["SET TRANSACTION ISOLATION LEVEL READ COMMITTED"],
		])("allows transaction/session statement %s", (query) => {
			expect(isRefused(query)).toBe(false);
		});
	});

	describe("writes are refused", () => {
		// The bypasses this ticket closes. Both are DDL per the grammar
		// (ddl_stmt -> collection_stmt -> flush_collection, and TRUNCATE), both empty a
		// collection, and both passed the deny-list gate because neither was listed.
		test.each([["FLUSH COLLECTION `a`"], ["TRUNCATE COLLECTION `a`"]])(
			"refuses previously-bypassing statement %s",
			(query) => {
				expect(isRefused(query)).toBe(true);
			},
		);

		// SIO-1813 regression set: everything the deny-list already caught must stay caught.
		test.each([
			["UPDATE `a` SET x=1"],
			["DELETE FROM `a`"],
			["INSERT INTO `a` VALUES(1,{})"],
			["UPSERT INTO `a` VALUES(1,{})"],
			["MERGE INTO `a` USING `b` ON a.id=b.id"],
			["CREATE INDEX i ON `a`(x)"],
			["DROP INDEX `a`.i"],
			["BUILD INDEX ON `a`(i)"],
			["GRANT admin TO u"],
			["REVOKE admin FROM u"],
			["ANALYZE `a`(x)"],
			["UPDATE STATISTICS FOR `a`(x)"],
			["PREPARE p AS SELECT 1"],
			["EXECUTE FUNCTION f()"],
			["EXECUTE p"],
			// SIO-1813: the head is read the way the query service lexer reads it
			["UPDATE`a` SET x=1"],
			["SELECT 1; DELETE FROM `a`"],
		])("refuses %s", (query) => {
			expect(isRefused(query)).toBe(true);
		});

		// The load-bearing assertion for an allow-list: a statement class nobody enumerated
		// -- a future one, or one simply overlooked -- is refused by default rather than
		// silently permitted. This is the case the deny-list could never satisfy.
		test.each([["KILL 12345"], ["VACUUM `a`"], ["CREATE SEQUENCE s"], ["ALTER COLLECTION `a`"]])(
			"refuses unrecognised statement class %s",
			(query) => {
				expect(isRefused(query)).toBe(true);
			},
		);
	});

	// Every refusal must be reported by at least one of the two predicates: the call sites
	// check `modifiesData(q) || modifiesStructure(q)`, so a write that both deny would slip
	// through. This guards the split between the two labels, not the refusal itself.
	test("every refused statement is claimed by exactly one predicate", () => {
		const writes = ["FLUSH COLLECTION `a`", "KILL 12345", "UPDATE `a` SET x=1", "CREATE INDEX i ON `a`(x)"];
		for (const query of writes) {
			const parsed = parser.parse(query);
			const claims = [parser.modifiesData(parsed), parser.modifiesStructure(parsed)].filter(Boolean);
			expect(claims).toHaveLength(1);
		}
	});
});

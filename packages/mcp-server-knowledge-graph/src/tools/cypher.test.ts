// src/tools/cypher.test.ts
//
// SIO-967: the read-only Cypher guard. kg_run_cypher is ON by default
// (KG_MCP_ALLOW_CYPHER=false to disable); this exercises the pure validator that
// gates every call.
import { describe, expect, test } from "bun:test";
import { validateReadOnlyCypher } from "./cypher.ts";

describe("validateReadOnlyCypher", () => {
	test("accepts a plain read query", () => {
		expect(validateReadOnlyCypher("MATCH (n:Service) RETURN n.name").ok).toBe(true);
	});

	test("accepts a parameterized read with a trailing semicolon", () => {
		expect(validateReadOnlyCypher("MATCH (n:Stack {name: $name}) RETURN n.name;").ok).toBe(true);
	});

	test("rejects empty input", () => {
		expect(validateReadOnlyCypher("   ").ok).toBe(false);
	});

	test.each([
		"CREATE",
		"MERGE",
		"SET",
		"DELETE",
		"DETACH",
		"REMOVE",
		"DROP",
		"ALTER",
		"COPY",
		"CALL",
	])("rejects the %s write/DDL keyword", (kw) => {
		const result = validateReadOnlyCypher(`MATCH (n) ${kw} (m:X) RETURN n`);
		expect(result.ok).toBe(false);
		expect(result.reason).toContain(kw);
	});

	test("rejects DETACH DELETE", () => {
		expect(validateReadOnlyCypher("MATCH (n:Service) DETACH DELETE n").ok).toBe(false);
	});

	test("does NOT trip on a write keyword inside a string literal", () => {
		// 'CREATE' here is a data value, not a clause -> allowed.
		expect(validateReadOnlyCypher("MATCH (n:Event {action: 'CREATE'}) RETURN n.name").ok).toBe(true);
	});

	test("does NOT trip on a keyword substring (CREATED is not CREATE)", () => {
		expect(validateReadOnlyCypher("MATCH (n:Change) RETURN n.createdAt").ok).toBe(true);
	});

	test("rejects an interior second statement", () => {
		expect(validateReadOnlyCypher("MATCH (n) RETURN n ; MATCH (m) RETURN m").ok).toBe(false);
	});

	test("ignores a write keyword in a comment", () => {
		expect(validateReadOnlyCypher("MATCH (n) RETURN n // CREATE later").ok).toBe(true);
	});
});

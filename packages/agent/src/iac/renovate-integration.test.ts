// agent/src/iac/renovate-integration.test.ts
import { describe, expect, test } from "bun:test";
import { parseRenovateTargetJson } from "./nodes.ts";

// Renovate on-demand MR automation: extractRenovateTarget's LLM call returns a JSON
// object with deployment+integration; parseRenovateTargetJson validates and normalizes
// it, returning null on malformed/incomplete output so the node can clarify instead of
// silently guessing.
describe("parseRenovateTargetJson", () => {
	test("parses a well-formed extraction", () => {
		expect(parseRenovateTargetJson('{"deployment":"eu-b2b","integration":"prometheus"}')).toEqual({
			deployment: "eu-b2b",
			integration: "prometheus",
		});
	});

	test("null when deployment is missing", () => {
		expect(parseRenovateTargetJson('{"integration":"prometheus"}')).toBeNull();
	});

	test("null when integration is missing", () => {
		expect(parseRenovateTargetJson('{"deployment":"eu-b2b"}')).toBeNull();
	});

	test("null when either field is an empty string", () => {
		expect(parseRenovateTargetJson('{"deployment":"","integration":"prometheus"}')).toBeNull();
		expect(parseRenovateTargetJson('{"deployment":"eu-b2b","integration":""}')).toBeNull();
	});

	test("null on malformed JSON", () => {
		expect(parseRenovateTargetJson("not json")).toBeNull();
	});

	test("tolerates surrounding prose (extracts the JSON block)", () => {
		expect(
			parseRenovateTargetJson('Here is the extraction: {"deployment":"ap-cld","integration":"cisco_ftd"} done.'),
		).toEqual({ deployment: "ap-cld", integration: "cisco_ftd" });
	});
});

// tests/json-extract.test.ts
import { expect, test } from "bun:test";
import { extractJsonPayload, jsonParseFailure } from "../extensions/jsonPayload";

const obj = { diagnoses: [{ dedup_key: "k", probable_cause: "c" }] };
const json = JSON.stringify(obj);

test("bare JSON object", () => {
	expect(extractJsonPayload(json)).toEqual(obj);
});

test("bare JSON array", () => {
	expect(extractJsonPayload("[1, 2, 3]")).toEqual([1, 2, 3]);
});

test("fenced with language tag", () => {
	expect(extractJsonPayload(`\`\`\`json\n${json}\n\`\`\``)).toEqual(obj);
});

test("fenced without language tag", () => {
	expect(extractJsonPayload(`\`\`\`\n${json}\n\`\`\``)).toEqual(obj);
});

test("prose before and after the object", () => {
	expect(extractJsonPayload(`Here is my diagnosis:\n\n${json}\n\nLet me know if you need more.`)).toEqual(obj);
});

test("braces inside JSON strings do not break extraction", () => {
	const tricky = { note: 'contains } and { and "quoted \\" brace }"' };
	expect(extractJsonPayload(`reply: ${JSON.stringify(tricky)} done`)).toEqual(tricky);
});

test("no JSON at all returns undefined", () => {
	expect(extractJsonPayload("I could not complete the investigation.")).toBeUndefined();
});

test("unbalanced braces return undefined", () => {
	expect(extractJsonPayload('{"a": 1')).toBeUndefined();
});

// SIO-1804. Reproduced against the old extractor before it was changed: every case below
// returned the inner `claims` array as if it were the whole reply.
const verdict = { verdict: "partially_confirmed", summary: "line one", claims: [{ claim: "x", status: "confirmed" }] };
const verdictJson = JSON.stringify(verdict);

test("a failed candidate is never descended into: no inner fragment comes back", () => {
	// Trailing commas are deliberately not repaired. The point is what comes back INSTEAD:
	// undefined, not the claims array inside the broken object.
	expect(extractJsonPayload(verdictJson.replace(/}$/, ",}"))).toBeUndefined();
});

test("a payload cut before its last brace returns undefined, not the array inside it", () => {
	expect(extractJsonPayload(verdictJson.slice(0, -1))).toBeUndefined();
});

test("a brace in the prose before the payload does not hide the payload", () => {
	expect(extractJsonPayload(`I checked the {cluster} state first.\n${verdictJson}`)).toEqual(verdict);
});

test("a raw newline or tab inside a string is repaired (the models emit them, SIO-1219)", () => {
	expect(extractJsonPayload(verdictJson.replace("line one", "line one\nline two"))).toEqual({
		...verdict,
		summary: "line one\nline two",
	});
	expect(extractJsonPayload(verdictJson.replace("line one", "a\tb"))).toEqual({ ...verdict, summary: "a\tb" });
});

test("control characters OUTSIDE strings are left alone: pretty-printed JSON still parses", () => {
	expect(extractJsonPayload(JSON.stringify(verdict, null, "\t"))).toEqual(verdict);
});

test("an already escaped newline is not double escaped", () => {
	const withEscaped = JSON.stringify({ ...verdict, summary: "one\ntwo" });
	expect(extractJsonPayload(withEscaped)).toEqual({ ...verdict, summary: "one\ntwo" });
});

test("the payload in a second fence is found when the first fence is not JSON", () => {
	expect(extractJsonPayload(`\`\`\`\nnotes\n\`\`\`\n\`\`\`json\n${verdictJson}\n\`\`\``)).toEqual(verdict);
});

test("a JSON null payload is a value, not a failure", () => {
	expect(extractJsonPayload("null")).toBeNull();
});

// SIO-1833: a prd spoke lost a good diagnosis to "response not valid JSON
// (6288 chars, stop=stop; starts: ... ends: ...)" -- length and two ends, never the
// cause. jsonParseFailure recovers the reason the parser already knew.

test("SIO-1833: a payload that parses has no failure to report", () => {
	expect(jsonParseFailure(json)).toBeNull();
	expect(jsonParseFailure(`\`\`\`json\n${json}\n\`\`\``)).toBeNull();
});

test.each([
	["trailing comma before ]", '{"diagnoses":[{"a":1},]}', "comma"],
	["trailing comma in object", '{"diagnoses":[{"a":1,}]}', "Property name"],
	["single quotes", "{'diagnoses':[]}", "Single quotes"],
	["unterminated", '{"diagnoses":[{"a":1}', "Expected"],
])("SIO-1833: %s is named in the failure", (_label, body, expected) => {
	const reason = jsonParseFailure(body);
	expect(reason).not.toBeNull();
	expect(reason).toContain(expected);
});

test("SIO-1833: a fenced payload reports the reason INSIDE the fence, not the backticks", () => {
	const reason = jsonParseFailure('```json\n{"diagnoses":[{"a":1},]}\n```') ?? "";
	expect(reason).toContain("in fence");
	expect(reason).toContain("comma");
	// The backtick failure is noise next to the real reason and must not be reported.
	expect(reason).not.toContain("Unrecognized token");
});

test("SIO-1833: the reason is parser text only and never echoes payload values", () => {
	const secret = "arn:aws:logs:eu-central-1:999999999999:log-group:/secret";
	const reason = jsonParseFailure(`{"diagnoses":[{"resource":"${secret}"},]}`) ?? "";
	expect(reason).not.toContain(secret);
	expect(reason).not.toContain("999999999999");
	expect(reason).toContain("comma");
});

test("SIO-1833: a non-JSON prose reply reports the parser's reason, unlabelled", () => {
	const reason = jsonParseFailure("sorry, plain prose only") ?? "";
	expect(reason).toContain("Unexpected identifier");
	// With no fence there is nothing to disambiguate, so no label is added, and the
	// boilerplate "JSON Parse error:" prefix is stripped to stay inside the SIO-1804 budget.
	expect(reason).not.toContain("whole:");
	expect(reason).not.toContain("JSON Parse error");
});

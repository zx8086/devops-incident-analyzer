// tests/reply-contract.test.ts
import { expect, test } from "bun:test";
import { isBlankReply } from "../contracts/reply.ts";

test("isBlankReply: undefined, null and whitespace-only strings are blank", () => {
	expect(isBlankReply(undefined)).toBe(true);
	expect(isBlankReply(null)).toBe(true);
	expect(isBlankReply("")).toBe(true);
	expect(isBlankReply("  \n\t")).toBe(true);
});

test("isBlankReply: any text, object or array is an answer", () => {
	expect(isBlankReply("ok")).toBe(false);
	expect(isBlankReply("null")).toBe(false);
	expect(isBlankReply({})).toBe(false);
	expect(isBlankReply([])).toBe(false);
	expect(isBlankReply(0)).toBe(false);
});

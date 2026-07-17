// apps/web/src/lib/ticket-errors.test.ts
import { describe, expect, test } from "bun:test";
import { errorFrom } from "./ticket-errors.ts";

describe("errorFrom", () => {
	test("returns the API error string when present", () => {
		expect(errorFrom({ error: "assignee not assignable" }, 502)).toBe("assignee not assignable");
	});

	test("falls back to a status line when error is missing or not a string", () => {
		expect(errorFrom({}, 400)).toBe("Request failed (400)");
		expect(errorFrom({ error: 123 }, 500)).toBe("Request failed (500)");
		expect(errorFrom(null, 404)).toBe("Request failed (404)");
		expect(errorFrom("not an object", 502)).toBe("Request failed (502)");
	});
});

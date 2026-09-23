// apps/web/src/lib/server/archify/flag.test.ts
import { describe, expect, test } from "bun:test";
import { isArchifyEnabled } from "./flag.ts";

describe("isArchifyEnabled (SIO-1877: default on, kill-switch only)", () => {
	test("unset, empty and any value other than false/0 mean enabled", () => {
		expect(isArchifyEnabled({})).toBe(true);
		expect(isArchifyEnabled({ ARCHIFY_DIAGRAMS_ENABLED: "" })).toBe(true);
		expect(isArchifyEnabled({ ARCHIFY_DIAGRAMS_ENABLED: "true" })).toBe(true);
		// A typo leaves a shipped feature on, not silently off.
		expect(isArchifyEnabled({ ARCHIFY_DIAGRAMS_ENABLED: "ture" })).toBe(true);
	});

	test("only an explicit false or 0 turns it off, in any case", () => {
		expect(isArchifyEnabled({ ARCHIFY_DIAGRAMS_ENABLED: "false" })).toBe(false);
		expect(isArchifyEnabled({ ARCHIFY_DIAGRAMS_ENABLED: "FALSE" })).toBe(false);
		expect(isArchifyEnabled({ ARCHIFY_DIAGRAMS_ENABLED: "0" })).toBe(false);
	});
});

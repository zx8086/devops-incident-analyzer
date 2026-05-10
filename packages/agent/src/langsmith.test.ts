// agent/src/langsmith.test.ts
import { describe, expect, it } from "bun:test";
import { _internal } from "./langsmith.ts";

const { trimLargeValues, MAX_FIELD_BYTES, MAX_VALUE_BYTES, SERVER_FIELD_LIMIT } = _internal;

function makeStringOfBytes(byteLength: number): string {
	return "x".repeat(byteLength);
}

describe("trimLargeValues", () => {
	it("returns input unchanged when total size is under MAX_FIELD_BYTES", () => {
		const input = { a: "small", b: 42, c: { nested: true } };
		const out = trimLargeValues(input);
		expect(out).toEqual(input);
	});

	it("returns null/undefined/non-object inputs unchanged (SDK may pass either)", () => {
		// The langsmith SDK at client.js:1793-1796 calls processInputs/processOutputs
		// on raw run.inputs/run.outputs which may be null/undefined or non-record shapes.
		// trimLargeValues must not throw on these or the run upload fails entirely.
		expect(trimLargeValues(null)).toBe(null);
		expect(trimLargeValues(undefined)).toBe(undefined);
		expect(trimLargeValues("string")).toBe("string");
		const arr = [1, 2, 3];
		expect(trimLargeValues(arr)).toBe(arr);
	});

	it("handles records with undefined values (JSON.stringify(undefined) returns undefined, not a string)", () => {
		// Bug found in v3: JSON.stringify(undefined).length throws; the size guard must
		// fall back to 0 for any value where JSON.stringify returns non-string.
		const input = { a: undefined, b: "real value", c: null };
		const out = trimLargeValues(input) as Record<string, unknown>;
		expect(out.a).toBe(undefined);
		expect(out.b).toBe("real value");
		expect(out.c).toBe(null);
	});

	it("truncates a single-key value over MAX_VALUE_BYTES even when record total is below threshold", () => {
		// SIO-687: captured 75MB ToolMessage had outputs.output single key over 75MB
		// while record total wasn't otherwise relevant. Per-key cap must fire.
		const huge = makeStringOfBytes(MAX_VALUE_BYTES + 1024);
		const out = trimLargeValues({ output: huge }) as Record<string, unknown>;
		expect(out.output).toMatch(/^\[truncated: \d+ bytes\]$/);
	});

	it("truncates the largest field first when total exceeds MAX_FIELD_BYTES", () => {
		const big = makeStringOfBytes(Math.floor(MAX_FIELD_BYTES * 0.7));
		const medium = makeStringOfBytes(Math.floor(MAX_FIELD_BYTES * 0.4));
		const small = "tiny";
		const out = trimLargeValues({ big, medium, small }) as Record<string, unknown>;
		expect(out.big).toMatch(/^\[truncated: \d+ bytes\]$/);
		expect(out.medium).toBe(medium);
		expect(out.small).toBe(small);
	});

	it("falls back to whole-record truncation when no per-key trim brings total under budget", () => {
		// Many tiny-but-untruncatable fields summing past the budget
		// (entries with size <= 1024 are NOT eligible for truncation by the loop guard,
		// so totalSize never decreases below the budget and the fallback path fires)
		const obj: Record<string, string> = {};
		for (let i = 0; i < 30000; i++) {
			obj[`k${i}`] = "x".repeat(800);
		}
		const out = trimLargeValues(obj) as Record<string, unknown>;
		expect(out._truncated).toMatch(/^\[entire payload truncated: \d+ bytes\]$/);
	});

	it("preserves field that fits even after another field is truncated", () => {
		const big = makeStringOfBytes(Math.floor(MAX_FIELD_BYTES * 1.2));
		const small = "preserved";
		const out = trimLargeValues({ big, small }) as Record<string, unknown>;
		expect(out.big).toMatch(/^\[truncated: \d+ bytes\]$/);
		expect(out.small).toBe(small);
	});

	it("handles the captured SIO-687 payload shape: { output: <single huge ToolMessage> }", () => {
		// Mimics the captured 75MB body from /tmp/sio687-fail-dump/.
		// outputs dict has exactly one key 'output' holding a serialized ToolMessage.
		const oneKeyOversized = {
			output: {
				lc_serializable: true,
				lc_kwargs: {
					status: "success",
					content: [{ type: "text", text: makeStringOfBytes(MAX_VALUE_BYTES + 100) }],
					type: "tool",
					tool_call_id: "tooluse_test",
				},
			},
		};
		const out = trimLargeValues(oneKeyOversized) as Record<string, unknown>;
		expect(out.output).toMatch(/^\[truncated: \d+ bytes\]$/);
	});

	it("MAX_FIELD_BYTES leaves headroom under SERVER_FIELD_LIMIT for multipart-encoding overhead", () => {
		expect(MAX_FIELD_BYTES).toBeLessThan(SERVER_FIELD_LIMIT);
		// SIO-687: 25 MiB server cap; 18 MiB JSON budget leaves ~7 MiB for multipart overhead.
		expect(SERVER_FIELD_LIMIT - MAX_FIELD_BYTES).toBeGreaterThan(4 * 1024 * 1024);
	});

	it("MAX_VALUE_BYTES is strictly under SERVER_FIELD_LIMIT", () => {
		expect(MAX_VALUE_BYTES).toBeLessThan(SERVER_FIELD_LIMIT);
		expect(MAX_VALUE_BYTES).toBeGreaterThan(MAX_FIELD_BYTES);
	});
});

// agent/src/iac/ilm-rollout.test.ts
import { describe, expect, test } from "bun:test";
import { mergeIlmPhases } from "./nodes.ts";

const POLICY = JSON.stringify(
	{
		name: "90-days@lifecycle",
		hot: { max_age: "30d", max_primary_shard_size: "50gb", min_docs: 1, rollover: true },
		warm: { min_age: "2d", forcemerge: { max_num_segments: 1 } },
		cold: { min_age: "30d" },
		delete: { min_age: "90d", delete_searchable_snapshot: true },
	},
	null,
	2,
);

describe("mergeIlmPhases", () => {
	test("replaces a scalar leaf and captures the previous value", () => {
		const { content, previous } = mergeIlmPhases(POLICY, { delete: { min_age: "60d" } });
		const parsed = JSON.parse(content) as { delete: { min_age: string; delete_searchable_snapshot: boolean } };
		expect(parsed.delete.min_age).toBe("60d");
		expect(parsed.delete.delete_searchable_snapshot).toBe(true);
		expect(previous).toEqual({ delete: { min_age: "90d" } });
	});

	test("deep-merges a nested object without clobbering siblings", () => {
		const { content, previous } = mergeIlmPhases(POLICY, { warm: { forcemerge: { max_num_segments: 2 } } });
		const parsed = JSON.parse(content) as { warm: { min_age: string; forcemerge: { max_num_segments: number } } };
		expect(parsed.warm.forcemerge.max_num_segments).toBe(2);
		expect(parsed.warm.min_age).toBe("2d");
		expect(previous).toEqual({ warm: { forcemerge: { max_num_segments: 1 } } });
	});

	test("applies a multi-phase patch in one call", () => {
		const { content, previous } = mergeIlmPhases(POLICY, {
			delete: { min_age: "60d" },
			warm: { forcemerge: { max_num_segments: 2 } },
		});
		const parsed = JSON.parse(content) as { delete: { min_age: string }; warm: { forcemerge: { max_num_segments: number } } };
		expect(parsed.delete.min_age).toBe("60d");
		expect(parsed.warm.forcemerge.max_num_segments).toBe(2);
		expect(previous).toEqual({ delete: { min_age: "90d" }, warm: { forcemerge: { max_num_segments: 1 } } });
	});

	test("preserves 2-space indent and a trailing newline", () => {
		const { content } = mergeIlmPhases(POLICY, { delete: { min_age: "60d" } });
		expect(content.endsWith("}\n")).toBe(true);
		expect(content).toContain('\n  "delete": {');
	});

	test("records undefined in previous for a leaf the policy did not have", () => {
		const { previous } = mergeIlmPhases(POLICY, { hot: { max_age: "30d", set_priority: { priority: 50 } } });
		// previous mirrors the patch's nesting; a brand-new leaf records undefined at the leaf.
		expect((previous as { hot: { set_priority: { priority?: unknown } } }).hot.set_priority.priority).toBeUndefined();
	});

	test("throws on non-object JSON", () => {
		expect(() => mergeIlmPhases("[]", { delete: { min_age: "60d" } })).toThrow();
	});
});

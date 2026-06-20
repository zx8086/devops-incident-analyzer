// agent/src/iac/ilm-validate.test.ts
// SIO-931: the policy JSON the agent writes must match modules/lifecycle/variables.tf (nested
// objects), or CI terraform plan rejects it. validateIlmPolicy is the pre-commit gate.
// SIO-990: validateIlmPhaseOrdering is the SEMANTIC pre-commit gate (phase min_age ordering).
import { describe, expect, test } from "bun:test";
import { validateIlmPhaseOrdering } from "./guards.ts";
import { CANONICAL_ILM_SHAPE, validateIlmPolicy } from "./nodes.ts";

const GOOD = {
	name: "us-default-lifecycle-logs-prod",
	hot: { priority: 100, max_age: "7d", max_primary_shard_size: "10gb", rollover: true },
	warm: {
		min_age: "6h",
		priority: 50,
		allocate: { number_of_replicas: 0 },
		forcemerge: { max_num_segments: 1 },
		shrink: { number_of_shards: 1, allow_write_after_shrink: false },
	},
	cold: { min_age: "2d", priority: 25, allocate: { number_of_replicas: 0 } },
	frozen: { min_age: "7d", searchable_snapshot: { snapshot_repository: "found-snapshots", force_merge_index: true } },
	delete: { min_age: "60d", delete_searchable_snapshot: true, wait_for_snapshot: { policy: "cloud-snapshot-policy" } },
};

describe("validateIlmPolicy (SIO-931)", () => {
	test("accepts a real nested policy", () => {
		expect(validateIlmPolicy(GOOD).ok).toBe(true);
	});

	test("accepts a sparse policy (delete only)", () => {
		expect(validateIlmPolicy({ name: "x", delete: { min_age: "30d" } }).ok).toBe(true);
	});

	test("rejects flat searchable_snapshot_repository with a nested-fix message", () => {
		const r = validateIlmPolicy({
			name: "x",
			frozen: { min_age: "7d", searchable_snapshot_repository: "found-snapshots" },
		});
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.reason).toContain("searchable_snapshot");
	});

	test("rejects set_priority", () => {
		const r = validateIlmPolicy({ name: "x", hot: { set_priority: { priority: 100 } } });
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.reason).toContain("priority");
	});

	test("rejects bare number_of_replicas on warm", () => {
		const r = validateIlmPolicy({ name: "x", warm: { min_age: "1d", number_of_replicas: 0 } });
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.reason).toContain("allocate");
	});

	test("rejects flat forcemerge_max_num_segments / shrink_number_of_shards", () => {
		expect(validateIlmPolicy({ name: "x", warm: { min_age: "1d", forcemerge_max_num_segments: 1 } }).ok).toBe(false);
		expect(validateIlmPolicy({ name: "x", warm: { min_age: "1d", shrink_number_of_shards: 1 } }).ok).toBe(false);
	});

	test("rejects flat wait_for_snapshot_policy", () => {
		const r = validateIlmPolicy({
			name: "x",
			delete: { min_age: "60d", wait_for_snapshot_policy: "cloud-snapshot-policy" },
		});
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.reason).toContain("wait_for_snapshot");
	});

	test("requires searchable_snapshot when frozen is present", () => {
		expect(validateIlmPolicy({ name: "x", frozen: { min_age: "7d" } }).ok).toBe(false);
	});

	test("CANONICAL_ILM_SHAPE is itself valid", () => {
		expect(validateIlmPolicy({ ...CANONICAL_ILM_SHAPE, name: "anything" }).ok).toBe(true);
	});

	test("accepts hot.min_age (real .alerts-ilm-policy carries it)", () => {
		expect(
			validateIlmPolicy({ name: ".alerts-ilm-policy", hot: { min_age: "0ms", rollover: false, max_age: "30d" } }).ok,
		).toBe(true);
	});
});

describe("validateIlmPhaseOrdering (SIO-990)", () => {
	test("accepts a non-decreasing policy (the GOOD shape)", () => {
		expect(validateIlmPhaseOrdering(GOOD).ok).toBe(true);
	});

	test("accepts the corrected metrics-apm policy (warm 3d -> cold 5d -> frozen 7d -> delete 14d)", () => {
		const ok = {
			name: "metrics-apm",
			warm: { min_age: "3d" },
			cold: { min_age: "5d" },
			frozen: { min_age: "7d", searchable_snapshot: { snapshot_repository: "found-snapshots" } },
			delete: { min_age: "14d" },
		};
		expect(validateIlmPhaseOrdering(ok).ok).toBe(true);
	});

	test("BLOCKS the 4d typo: delete.min_age 4d below frozen 7d (the logged bug)", () => {
		const bad = {
			name: "metrics-apm",
			warm: { min_age: "3d" },
			cold: { min_age: "5d" },
			frozen: { min_age: "7d", searchable_snapshot: { snapshot_repository: "found-snapshots" } },
			delete: { min_age: "4d" },
		};
		const r = validateIlmPhaseOrdering(bad);
		expect(r.ok).toBe(false);
		if (!r.ok) {
			expect(r.reason).toContain("delete");
			expect(r.reason).toContain("frozen");
			expect(r.reason).toContain("4d");
		}
	});

	test("blocks an earlier-phase inversion (cold below warm)", () => {
		const bad = { name: "x", warm: { min_age: "5d" }, cold: { min_age: "2d" } };
		expect(validateIlmPhaseOrdering(bad).ok).toBe(false);
	});

	test("accepts equal min_ages (non-decreasing, not strictly increasing)", () => {
		const eq = {
			name: "x",
			frozen: { min_age: "7d", searchable_snapshot: { snapshot_repository: "found-snapshots" } },
			delete: { min_age: "7d" },
		};
		expect(validateIlmPhaseOrdering(eq).ok).toBe(true);
	});

	test("ignores phases with no/unparseable min_age (hot has none; sparse policy is fine)", () => {
		expect(validateIlmPhaseOrdering({ name: "x", hot: { rollover: true }, delete: { min_age: "30d" } }).ok).toBe(true);
	});

	test("handles mixed units (48h <= 3d <= 5d)", () => {
		const ok = { name: "x", warm: { min_age: "48h" }, cold: { min_age: "3d" }, delete: { min_age: "5d" } };
		expect(validateIlmPhaseOrdering(ok).ok).toBe(true);
	});

	test("blocks mixed-unit inversion (warm 49h > cold 2d=48h)", () => {
		const bad = { name: "x", warm: { min_age: "49h" }, cold: { min_age: "2d" } };
		expect(validateIlmPhaseOrdering(bad).ok).toBe(false);
	});
});

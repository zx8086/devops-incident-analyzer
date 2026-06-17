// agent/src/iac/ilm-validate.test.ts
// SIO-931: the policy JSON the agent writes must match modules/lifecycle/variables.tf (nested
// objects), or CI terraform plan rejects it. validateIlmPolicy is the pre-commit gate.
import { describe, expect, test } from "bun:test";
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
});

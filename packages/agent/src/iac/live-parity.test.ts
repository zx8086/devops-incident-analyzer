// agent/src/iac/live-parity.test.ts
import { describe, expect, test } from "bun:test";
import {
	computeIlmLiveParity,
	type EsIlmPolicy,
	esIlmPolicyToFlatDsl,
	parseEsIlmPolicyResponse,
	renderLiveParity,
} from "./live-parity.ts";

// Parse the fixture, asserting it is well-formed (keeps the tests free of `!` non-null assertions).
const parsed = (raw: string): EsIlmPolicy => {
	const p = parseEsIlmPolicyResponse(raw);
	if (!p) throw new Error("fixture did not parse");
	return p;
};

// SIO-983: the elastic-iac MCP's elastic_ilm_get_lifecycle does a raw GET against
// /_ilm/policy/<name> and returns "[<status>] <raw ES JSON>". The raw ES ILM API nests every
// setting under policy.phases.<phase>.actions.<action>.<field>. Shape verified live against the
// running elastic MCP (2026-06-20). The repo files use a FLAT DSL (hot.max_age, warm.allocate...),
// so a parity diff must first normalise the ES shape into that flat DSL or every key would mismatch.

// A realistic raw ES _ilm/policy response (cost-optimised metrics-style policy), wrapped as the
// elastic-iac MCP returns it.
const RAW_ES_METRICS = `[200] ${JSON.stringify({
	metrics: {
		version: 7,
		modified_date: "2026-06-15T07:32:11.079Z",
		policy: {
			phases: {
				hot: {
					min_age: "0ms",
					actions: {
						rollover: { max_age: "3d", max_primary_shard_size: "40gb", min_docs: 500000 },
						set_priority: { priority: 100 },
					},
				},
				warm: {
					min_age: "3d",
					actions: {
						set_priority: { priority: 50 },
						allocate: { number_of_replicas: 0 },
					},
				},
				cold: {
					min_age: "5d",
					actions: {
						set_priority: { priority: 25 },
						allocate: { number_of_replicas: 0 },
						readonly: {},
					},
				},
				frozen: {
					min_age: "7d",
					actions: {
						searchable_snapshot: { snapshot_repository: "found-snapshots", force_merge_index: true },
					},
				},
				delete: {
					min_age: "30d",
					actions: {
						delete: { delete_searchable_snapshot: true },
					},
				},
			},
		},
	},
})}`;

describe("parseEsIlmPolicyResponse (SIO-983)", () => {
	test("strips the [status] prefix and unwraps the single policy entry", () => {
		const parsed = parseEsIlmPolicyResponse(RAW_ES_METRICS);
		expect(parsed).not.toBeNull();
		expect(parsed?.phases.hot).toBeDefined();
		expect(parsed?.phases.delete?.min_age).toBe("30d");
	});

	test("returns null for a non-2xx / placeholder body (not configured, 404)", () => {
		expect(parseEsIlmPolicyResponse("[cluster '(unset)' not configured: ...]")).toBeNull();
		expect(parseEsIlmPolicyResponse("[404] {}")).toBeNull();
		expect(parseEsIlmPolicyResponse("")).toBeNull();
		expect(parseEsIlmPolicyResponse("[200] not-json")).toBeNull();
	});
});

describe("esIlmPolicyToFlatDsl (SIO-983)", () => {
	test("maps the raw ES actions shape into the repo flat DSL", () => {
		const flat = esIlmPolicyToFlatDsl(parsed(RAW_ES_METRICS));
		expect(flat).toEqual({
			hot: { max_age: "3d", max_primary_shard_size: "40gb", min_docs: 500000, priority: 100, rollover: true },
			warm: { min_age: "3d", priority: 50, allocate: { number_of_replicas: 0 } },
			cold: { min_age: "5d", priority: 25, allocate: { number_of_replicas: 0 }, readonly: true },
			frozen: {
				min_age: "7d",
				searchable_snapshot: { snapshot_repository: "found-snapshots", force_merge_index: true },
			},
			delete: { min_age: "30d", delete_searchable_snapshot: true },
		});
	});

	test("drops the implicit hot.min_age '0ms' (it is the ES default, not a meaningful repo field)", () => {
		const flat = esIlmPolicyToFlatDsl(parsed(RAW_ES_METRICS));
		expect((flat.hot as Record<string, unknown>).min_age).toBeUndefined();
	});
});

describe("computeIlmLiveParity (SIO-983)", () => {
	test("flags phases present in the draft but NOT in live (the forcemerge/shrink/wait_for_snapshot case)", () => {
		const live = esIlmPolicyToFlatDsl(parsed(RAW_ES_METRICS));
		// The drafted policy is the live one PLUS extra actions the user never asked for, copied from a
		// stale repo source: warm.forcemerge, warm.shrink, delete.wait_for_snapshot.
		const draft = {
			name: "metrics-custom",
			hot: { max_age: "3d", max_primary_shard_size: "40gb", min_docs: 500000, priority: 100, rollover: true },
			warm: {
				min_age: "3d",
				priority: 50,
				allocate: { number_of_replicas: 0 },
				forcemerge: { max_num_segments: 1 },
				shrink: { number_of_shards: 1 },
			},
			cold: { min_age: "5d", priority: 25, allocate: { number_of_replicas: 0 }, readonly: true },
			frozen: {
				min_age: "7d",
				searchable_snapshot: { snapshot_repository: "found-snapshots", force_merge_index: true },
			},
			delete: {
				min_age: "30d",
				delete_searchable_snapshot: true,
				wait_for_snapshot: { policy: "cloud-snapshot-policy" },
			},
		};
		const parity = computeIlmLiveParity(live, draft);
		const inDraftPaths = parity.inDraftNotLive.map((l) => l.path).sort();
		expect(inDraftPaths).toEqual([
			"delete.wait_for_snapshot.policy",
			"warm.forcemerge.max_num_segments",
			"warm.shrink.number_of_shards",
		]);
		expect(parity.inLiveNotDraft).toHaveLength(0);
		expect(parity.valueDiffers).toHaveLength(0);
		expect(parity.hasDrift).toBe(true);
	});

	test("a faithful like-for-like copy (name aside) reports NO drift", () => {
		const live = esIlmPolicyToFlatDsl(parsed(RAW_ES_METRICS));
		const draft = { name: "metrics-custom", ...structuredClone(live) };
		const parity = computeIlmLiveParity(live, draft);
		expect(parity.hasDrift).toBe(false);
		expect(parity.inDraftNotLive).toHaveLength(0);
		expect(parity.inLiveNotDraft).toHaveLength(0);
		expect(parity.valueDiffers).toHaveLength(0);
	});

	test("flags a changed value (draft retention differs from live)", () => {
		const live = esIlmPolicyToFlatDsl(parsed(RAW_ES_METRICS));
		const draft: Record<string, unknown> = { name: "metrics-custom", ...structuredClone(live) };
		(draft.delete as Record<string, unknown>).min_age = "60d";
		const parity = computeIlmLiveParity(live, draft);
		expect(parity.valueDiffers).toEqual([{ path: "delete.min_age", live: "30d", draft: "60d" }]);
		expect(parity.hasDrift).toBe(true);
	});

	test("flags a phase present in live but missing from the draft", () => {
		const live = esIlmPolicyToFlatDsl(parsed(RAW_ES_METRICS));
		// Draft drops the frozen phase entirely (omit it rather than delete).
		const { frozen: _frozen, ...rest } = structuredClone(live);
		const draft = { name: "metrics-custom", ...rest };
		const parity = computeIlmLiveParity(live, draft);
		const inLivePaths = parity.inLiveNotDraft.map((l) => l.path);
		expect(inLivePaths).toContain("frozen.min_age");
		expect(inLivePaths).toContain("frozen.searchable_snapshot.snapshot_repository");
		expect(parity.hasDrift).toBe(true);
	});
});

describe("renderLiveParity (SIO-983)", () => {
	test("returns empty string when there is no drift", () => {
		expect(renderLiveParity({ inDraftNotLive: [], inLiveNotDraft: [], valueDiffers: [], hasDrift: false })).toBe("");
	});

	test("renders a concise markdown block listing the in-draft-not-live fields", () => {
		const md = renderLiveParity({
			inDraftNotLive: [
				{ path: "warm.forcemerge.max_num_segments", draft: 1 },
				{ path: "delete.wait_for_snapshot.policy", draft: "cloud-snapshot-policy" },
			],
			inLiveNotDraft: [],
			valueDiffers: [],
			hasDrift: true,
		});
		expect(md).toContain("Differs from live cluster");
		expect(md).toContain("warm.forcemerge.max_num_segments");
		expect(md).toContain("delete.wait_for_snapshot.policy");
		// present in draft but not live -> rendered as an addition
		expect(md).toContain("not in live");
	});
});

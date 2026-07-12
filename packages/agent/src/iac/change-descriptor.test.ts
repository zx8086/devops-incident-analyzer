// agent/src/iac/change-descriptor.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { reviewPlan, summarizeNestedPatch } from "./nodes.ts";
import type { IacStateType } from "./state.ts";

const asIacState = (partial: Partial<IacStateType>): IacStateType => partial as unknown as IacStateType;

// SIO-989: summarizeNestedPatch turns a nested phasesPatch/settingsPatch into a compact,
// one-glance per-field summary for the Change line. Pure, deterministic, no LLM, no emojis.
describe("summarizeNestedPatch (SIO-989)", () => {
	test("nested phasesPatch groups leaves by phase with dotted sub-paths", () => {
		const patch = {
			warm: { forcemerge: { max_num_segments: 1 }, shrink: { number_of_shards: 1 } },
			cold: { allocate: { number_of_replicas: 0 } },
		};
		// warm groups its two leaves; cold its one; phases comma-separated, leaves space-separated.
		expect(summarizeNestedPatch(patch)).toBe(
			"warm forcemerge.max_num_segments=1 shrink.number_of_shards=1, cold allocate.number_of_replicas=0",
		);
	});

	test("a retention reduction surfaces as a delete.min_age leaf", () => {
		expect(summarizeNestedPatch({ delete: { min_age: "60d" } })).toBe("delete min_age=60d");
	});

	test("a flat settingsPatch renders bare key=value (no phase grouping)", () => {
		expect(summarizeNestedPatch({ refresh_interval: "30s" })).toBe("refresh_interval=30s");
	});

	test("a nested settingsPatch renders the top key as the group + dotted leaf", () => {
		expect(summarizeNestedPatch({ routing: { allocation: { total_shards_per_node: 2 } } })).toBe(
			"routing allocation.total_shards_per_node=2",
		);
	});

	test("string values are unquoted; non-strings stringified", () => {
		expect(summarizeNestedPatch({ warm: { readonly: true } })).toBe("warm readonly=true");
		expect(summarizeNestedPatch({ hot: { priority: 100 } })).toBe("hot priority=100");
	});

	test("caps to maxLeaves and appends +k more on one line", () => {
		const patch = {
			warm: { a: 1, b: 2, c: 3 },
			cold: { d: 4, e: 5 },
		};
		const out = summarizeNestedPatch(patch, { maxLeaves: 3 });
		expect(out).not.toContain("\n");
		expect(out).toContain("+2 more");
		// the first 3 leaves are kept in order (warm a/b/c)
		expect(out.startsWith("warm a=1 b=2 c=3")).toBe(true);
	});

	test("empty or undefined patch -> empty string (caller keeps the phase-name form)", () => {
		expect(summarizeNestedPatch({})).toBe("");
		expect(summarizeNestedPatch(undefined)).toBe("");
	});
});

// SIO-989: the reviewPlan title (which becomes the "Change:" line live + on recall) carries the
// actual per-field edits for ilm-rollout and cluster-default-edit, not just the phase/setting names.
describe("reviewPlan title enrichment (SIO-989)", () => {
	test("ilm-rollout single policy: title names the per-field edits, not just phase names", async () => {
		const state = asIacState({
			iacRequest: {
				workflow: "ilm-rollout",
				isProd: false,
				cluster: "eu-b2b",
				policyName: "metrics-apm.app_metrics_default_policy",
				phasesPatch: {
					warm: { forcemerge: { max_num_segments: 1 }, shrink: { number_of_shards: 1 } },
					cold: { allocate: { number_of_replicas: 0 } },
				},
			},
			branch: "b",
			proposedDiff: "(diff)",
			precheckPassed: true,
		});
		const title = (await reviewPlan(state)).planReview?.title ?? "";
		expect(title).toContain("forcemerge.max_num_segments=1");
		expect(title).toContain("shrink.number_of_shards=1");
		expect(title).toContain("number_of_replicas=0");
		// the old terse "warm, cold" pair is no longer the descriptor body
		expect(title).not.toContain("warm, cold");
	});

	test("ilm-rollout copy (sourcePolicy, empty phasesPatch) falls back to 'change' (no empty descriptor)", async () => {
		const state = asIacState({
			iacRequest: {
				workflow: "ilm-rollout",
				isProd: false,
				cluster: "eu-b2b",
				policyName: "metrics-copy@lifecycle",
				sourcePolicy: "metrics@lifecycle",
			},
			policyCreated: true,
			branch: "b",
			proposedDiff: "(diff)",
			precheckPassed: true,
		});
		const title = (await reviewPlan(state)).planReview?.title ?? "";
		expect(title).toContain("metrics-copy@lifecycle");
		expect(title).toContain("create");
		expect(title).toContain("change");
		// no dangling ": :" or empty field run
		expect(title).not.toContain(": :");
	});

	test("ilm-rollout multi-policy: shared patch is summarized per field", async () => {
		const state = asIacState({
			iacRequest: {
				workflow: "ilm-rollout",
				isProd: false,
				cluster: "eu-b2b",
				ilmPolicies: [
					{ policyName: "metrics@lifecycle", phasesPatch: { cold: { allocate: { number_of_replicas: 0 } } } },
					{ policyName: "logs@lifecycle", phasesPatch: { cold: { allocate: { number_of_replicas: 0 } } } },
				],
			},
			branch: "b",
			proposedDiff: "(diff)",
			precheckPassed: true,
		});
		const title = (await reviewPlan(state)).planReview?.title ?? "";
		expect(title).toContain("2 ILM policies");
		expect(title).toContain("number_of_replicas=0");
	});

	test("cluster-default freeform settingsPatch: title names the field value", async () => {
		const state = asIacState({
			iacRequest: {
				workflow: "cluster-default-edit",
				isProd: false,
				cluster: "eu-b2b",
				templateName: "logs",
				settingsPatch: { refresh_interval: "30s" },
			},
			branch: "b",
			proposedDiff: "(diff)",
			precheckPassed: true,
		});
		const title = (await reviewPlan(state)).planReview?.title ?? "";
		expect(title).toContain("logs");
		expect(title).toContain("refresh_interval=30s");
		expect(title).not.toContain("total_shards_per_node ?");
	});
});

// SIO-1083: reviewPlan stamps a three-state status per recall source so the card can tell a
// disabled backend ("off" -> hide) from an enabled-but-cold one ("empty" -> show a no-records
// line) from one with hits ("populated" -> render the list). The status is derived from each
// source's OWN backend gate, NOT from whether the context string is empty (both the disabled and
// cold cases leave that string ""), which is exactly the ambiguity the card could not resolve.
describe("reviewPlan recall status (SIO-1083)", () => {
	const prevKg = process.env.KNOWLEDGE_GRAPH_ENABLED;
	const prevBackend = process.env.LIVE_MEMORY_BACKEND;
	beforeEach(() => {
		delete process.env.KNOWLEDGE_GRAPH_ENABLED;
		delete process.env.LIVE_MEMORY_BACKEND;
	});
	afterEach(() => {
		if (prevKg === undefined) delete process.env.KNOWLEDGE_GRAPH_ENABLED;
		else process.env.KNOWLEDGE_GRAPH_ENABLED = prevKg;
		if (prevBackend === undefined) delete process.env.LIVE_MEMORY_BACKEND;
		else process.env.LIVE_MEMORY_BACKEND = prevBackend;
	});

	const baseState = (over: Partial<IacStateType> = {}): IacStateType =>
		asIacState({
			iacRequest: { workflow: "cluster-default-edit", isProd: false, cluster: "eu-b2b", templateName: "logs" },
			branch: "b",
			proposedDiff: "(diff)",
			precheckPassed: true,
			...over,
		});

	test("both backends off -> both statuses 'off' (card hides both sections)", async () => {
		const review = (await reviewPlan(baseState({ iacGraphContext: "", priorLearnings: "" }))).planReview;
		expect(review?.recentChangesStatus).toBe("off");
		expect(review?.priorLearningsStatus).toBe("off");
	});

	test("backends on but cold (no context) -> both statuses 'empty' (card shows no-records line)", async () => {
		process.env.KNOWLEDGE_GRAPH_ENABLED = "true";
		process.env.LIVE_MEMORY_BACKEND = "agent-memory";
		const review = (await reviewPlan(baseState({ iacGraphContext: "", priorLearnings: "" }))).planReview;
		expect(review?.recentChangesStatus).toBe("empty");
		expect(review?.priorLearningsStatus).toBe("empty");
	});

	test("backends on with context -> both statuses 'populated' (card renders the list)", async () => {
		process.env.KNOWLEDGE_GRAPH_ENABLED = "true";
		process.env.LIVE_MEMORY_BACKEND = "agent-memory";
		const review = (
			await reviewPlan(baseState({ iacGraphContext: "## Recent changes\n- prior", priorLearnings: "- learned" }))
		).planReview;
		expect(review?.recentChangesStatus).toBe("populated");
		expect(review?.priorLearningsStatus).toBe("populated");
	});

	test("statuses are independent: KG on+cold, memory off -> empty vs off (the gl-testing asymmetry surfaces)", async () => {
		process.env.KNOWLEDGE_GRAPH_ENABLED = "true";
		delete process.env.LIVE_MEMORY_BACKEND;
		const review = (await reviewPlan(baseState({ iacGraphContext: "", priorLearnings: "" }))).planReview;
		expect(review?.recentChangesStatus).toBe("empty");
		expect(review?.priorLearningsStatus).toBe("off");
	});
});

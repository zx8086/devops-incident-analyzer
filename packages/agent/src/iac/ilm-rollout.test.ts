// agent/src/iac/ilm-rollout.test.ts
import { describe, expect, mock, test } from "bun:test";
import { branchSlug, deploymentJsonPath, detectRetentionReduction, mergeIlmPhases, parseIntentJson } from "./nodes.ts";
import type { IacRequest } from "./state.ts";

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
		const parsed = JSON.parse(content) as {
			delete: { min_age: string };
			warm: { forcemerge: { max_num_segments: number } };
		};
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

describe("detectRetentionReduction", () => {
	test("flags a shorter delete.min_age as a reduction", () => {
		const r = detectRetentionReduction({ delete: { min_age: "90d" } }, { delete: { min_age: "30d" } });
		expect(r).toEqual({ from: "90d", to: "30d" });
	});

	test("returns null when retention increases", () => {
		expect(detectRetentionReduction({ delete: { min_age: "30d" } }, { delete: { min_age: "60d" } })).toBeNull();
	});

	test("compares across units (48h is shorter than 3d)", () => {
		const r = detectRetentionReduction({ delete: { min_age: "3d" } }, { delete: { min_age: "48h" } });
		expect(r).toEqual({ from: "3d", to: "48h" });
	});

	test("returns null when the patch does not touch delete.min_age", () => {
		expect(detectRetentionReduction({ warm: { min_age: "2d" } }, { warm: { min_age: "1d" } })).toBeNull();
	});

	test("returns null on an unparseable duration", () => {
		expect(detectRetentionReduction({ delete: { min_age: "90d" } }, { delete: { min_age: "forever" } })).toBeNull();
	});
});

describe("parseIntentJson — ilm-rollout", () => {
	test("extracts workflow/cluster/policyName/phasesPatch with no clarification", () => {
		const raw = JSON.stringify({
			workflow: "ilm-rollout",
			cluster: "eu-b2b",
			policyName: "30-days@lifecycle",
			phasesPatch: { delete: { min_age: "60d" } },
		});
		const req = parseIntentJson(raw);
		expect(req.workflow).toBe("ilm-rollout");
		expect(req.cluster).toBe("eu-b2b");
		expect(req.policyName).toBe("30-days@lifecycle");
		expect(req.phasesPatch).toEqual({ delete: { min_age: "60d" } });
		expect(req.clarification).toBeUndefined();
	});

	test("normalizes an explicit-null phasesPatch to undefined", () => {
		const raw = JSON.stringify({ workflow: "ilm-rollout", cluster: "eu-b2b", policyName: "logs", phasesPatch: null });
		const req = parseIntentJson(raw);
		expect(req.phasesPatch).toBeUndefined();
	});
});

describe("deploymentJsonPath — ${policy} substitution", () => {
	test("substitutes both cluster and policy, preserving @ and . in the filename", () => {
		const path = deploymentJsonPath(
			"environments/${cluster}/lifecycle-policies/${policy}.json",
			"eu-b2b",
			"30-days@lifecycle",
		);
		expect(path).toBe("environments/eu-b2b/lifecycle-policies/30-days@lifecycle.json");
	});

	test("still works for a cluster-only template (back-compat)", () => {
		expect(deploymentJsonPath("environments/_deployments/${cluster}.json", "ap-cld")).toBe(
			"environments/_deployments/ap-cld.json",
		);
	});
});

describe("branchSlug — ilm-rollout", () => {
	test("uses policyName as the descriptor and slugs @/.", () => {
		const req: IacRequest = {
			workflow: "ilm-rollout",
			isProd: false,
			cluster: "eu-b2b",
			policyName: "30-days@lifecycle",
		};
		// slug lowercases and replaces non-[a-z0-9-] runs with a single '-'
		expect(branchSlug(req)).toBe("eu-b2b-30-days-lifecycle-ilm-rollout");
	});
});

// Build a fake tool set so callTool() inside nodes.ts resolves against our stubs.
function mockTools(handlers: Record<string, (args: Record<string, unknown>) => string>) {
	const tools = Object.entries(handlers).map(([name, fn]) => ({
		name,
		invoke: async (args: Record<string, unknown>) => fn(args),
	}));
	mock.module("../mcp-bridge.ts", () => ({
		getToolsForDataSource: () => tools,
		getConnectedServers: () => ["elastic-iac-mcp"],
	}));
}

describe("draftChange -> proposeIlmChange", () => {
	test("happy path: edits the policy JSON, commits, sets precheckPassed + diff", async () => {
		const { draftChange } = await import("./nodes.ts");
		const policy = JSON.stringify({ name: "30-days@lifecycle", delete: { min_age: "30d" } }, null, 2);
		mockTools({
			gitlab_get_file_content: () =>
				`[200] ${JSON.stringify({ content: Buffer.from(policy).toString("base64"), encoding: "base64" })}`,
			gitlab_create_branch: () => "[201] {}",
			gitlab_commit_file: () => "[201] {}",
		});
		const state = {
			iacRequest: {
				workflow: "ilm-rollout" as const,
				isProd: false,
				cluster: "eu-b2b",
				policyName: "30-days@lifecycle",
				phasesPatch: { delete: { min_age: "60d" } },
			},
		};
		// biome-ignore lint/suspicious/noExplicitAny: SIO-880 - partial IacState test stub
		const result = await draftChange(state as any);
		expect(result.precheckPassed).toBe(true);
		expect(result.proposedFilePath).toBe("environments/eu-b2b/lifecycle-policies/30-days@lifecycle.json");
		expect(result.proposedDiff).toContain('"min_age"');
		expect(result.retentionChange).toBeNull(); // 30d -> 60d is an INCREASE, not a reduction
	});

	test("blocks with a clear message when phasesPatch is empty", async () => {
		const { draftChange } = await import("./nodes.ts");
		mockTools({});
		const state = {
			iacRequest: { workflow: "ilm-rollout" as const, isProd: false, cluster: "eu-b2b", policyName: "logs" },
		};
		// biome-ignore lint/suspicious/noExplicitAny: SIO-880 - partial IacState test stub
		const result = await draftChange(state as any);
		expect(result.blockedReason).toContain("phase field");
	});

	test("blocks when the policy file 404s", async () => {
		const { draftChange } = await import("./nodes.ts");
		mockTools({ gitlab_get_file_content: () => '[404] {"message":"404 File Not Found"}' });
		const state = {
			iacRequest: {
				workflow: "ilm-rollout" as const,
				isProd: false,
				cluster: "eu-b2b",
				policyName: "no-such-policy",
				phasesPatch: { delete: { min_age: "60d" } },
			},
		};
		// biome-ignore lint/suspicious/noExplicitAny: SIO-880 - partial IacState test stub
		const result = await draftChange(state as any);
		expect(result.blockedReason).toContain("no such policy");
	});

	test("sets retentionChange when retention is reduced", async () => {
		const { draftChange } = await import("./nodes.ts");
		const policy = JSON.stringify({ name: "90-days@lifecycle", delete: { min_age: "90d" } }, null, 2);
		mockTools({
			gitlab_get_file_content: () =>
				`[200] ${JSON.stringify({ content: Buffer.from(policy).toString("base64"), encoding: "base64" })}`,
			gitlab_create_branch: () => "[201] {}",
			gitlab_commit_file: () => "[201] {}",
		});
		const state = {
			iacRequest: {
				workflow: "ilm-rollout" as const,
				isProd: false,
				cluster: "eu-cld",
				policyName: "90-days@lifecycle",
				phasesPatch: { delete: { min_age: "30d" } },
			},
		};
		// biome-ignore lint/suspicious/noExplicitAny: SIO-880 - partial IacState test stub
		const result = await draftChange(state as any);
		expect(result.retentionChange).toEqual({ from: "90d", to: "30d" });
	});
});

describe("reviewPlan — ilm-rollout", () => {
	const baseState = (retentionChange: { from: string; to: string } | null) => ({
		iacRequest: {
			workflow: "ilm-rollout" as const,
			isProd: false,
			cluster: "eu-cld",
			policyName: "90-days@lifecycle",
			phasesPatch: { delete: { min_age: retentionChange?.to ?? "120d" } },
		},
		branch: "agent/eu-cld-90-days-lifecycle-ilm-rollout-20260602",
		proposedDiff: "diff",
		precheckPassed: true,
		retentionChange,
	});

	test("marks the review kind config-edit and skips local terraform", async () => {
		const { reviewPlan } = await import("./nodes.ts");
		// biome-ignore lint/suspicious/noExplicitAny: SIO-880 - partial IacState test stub
		const result = await reviewPlan(baseState(null) as any);
		expect(result.planReview?.kind).toBe("config-edit");
		expect(result.planReview?.plan).toContain("CI computes the Terraform plan");
	});

	test("adds the always-on ILM phase-transition risk", async () => {
		const { reviewPlan } = await import("./nodes.ts");
		// biome-ignore lint/suspicious/noExplicitAny: SIO-880 - partial IacState test stub
		const result = await reviewPlan(baseState(null) as any);
		expect(result.risks?.some((r) => r.includes("force-merge") || r.includes("rolls over"))).toBe(true);
	});

	test("prepends a HIGH retention-reduction risk when retention is reduced", async () => {
		const { reviewPlan } = await import("./nodes.ts");
		// biome-ignore lint/suspicious/noExplicitAny: SIO-880 - partial IacState test stub
		const result = await reviewPlan(baseState({ from: "90d", to: "30d" }) as any);
		expect(result.risks?.[0]).toContain("Retention REDUCED 90d->30d");
		expect(result.risks?.[0]).toContain("irrecoverable");
	});
});

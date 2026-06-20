// agent/src/iac/ilm-copy.test.ts
// SIO-931: copy-from-reference. parseIntentJson lifts sourcePolicy; proposeIlmChange uses the
// source policy as the (correctly-shaped) base and merges overrides.
import { describe, expect, mock, test } from "bun:test";
import { parseIntentJson, parseRepoTreeFiles } from "./nodes.ts";
import type { IacStateType } from "./state.ts";

const asIacState = (partial: Partial<IacStateType>): IacStateType => partial as unknown as IacStateType;

const SOURCE_JSON = JSON.stringify({
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
});
const b64 = (s: string) =>
	`[200] ${JSON.stringify({ content: Buffer.from(s).toString("base64"), encoding: "base64" })}`;

function mockBridge(byTool: Record<string, (args: Record<string, unknown>) => string>) {
	mock.module("../mcp-bridge.ts", () => ({
		getConnectedServers: () => ["elastic-iac-mcp"],
		getToolsForDataSource: () =>
			Object.entries(byTool).map(([name, handler]) => ({
				name,
				invoke: async (args: Record<string, unknown>) => handler(args),
			})),
	}));
}

describe("parseIntentJson sourcePolicy (SIO-931)", () => {
	test("lifts sourcePolicy + policyName from a copy request", () => {
		const req = parseIntentJson(
			JSON.stringify({
				workflow: "ilm-rollout",
				cluster: "us-cld",
				policyName: "logs@lifecycle",
				sourcePolicy: "us-default-lifecycle-logs-prod",
			}),
		);
		expect(req.workflow).toBe("ilm-rollout");
		expect(req.policyName).toBe("logs@lifecycle");
		expect(req.sourcePolicy).toBe("us-default-lifecycle-logs-prod");
	});

	test("sourcePolicy is undefined for a plain change", () => {
		const req = parseIntentJson(
			JSON.stringify({
				workflow: "ilm-rollout",
				cluster: "us-cld",
				policyName: "logs",
				phasesPatch: { delete: { min_age: "60d" } },
			}),
		);
		expect(req.sourcePolicy).toBeUndefined();
	});
});

describe("parseRepoTreeFiles (SIO-931)", () => {
	test("returns blob names, ignoring trees", () => {
		const tree = `[200] ${JSON.stringify([
			{ name: "basic-lifecycle-logs.json", type: "blob" },
			{ name: "us-default-lifecycle-logs-prod.json", type: "blob" },
			{ name: "subdir", type: "tree" },
		])}`;
		expect(parseRepoTreeFiles(tree)).toEqual(["basic-lifecycle-logs.json", "us-default-lifecycle-logs-prod.json"]);
	});

	test("empty on unparseable", () => {
		expect(parseRepoTreeFiles("[404] not found")).toEqual([]);
	});
});

describe("proposeIlmChange copy path (SIO-931)", () => {
	test("copies the source policy (nested), applies override, passes validation", async () => {
		const committed: { content?: string } = {};
		mockBridge({
			gitlab_get_file_content: (a) =>
				String(a.filePath).includes("us-default-lifecycle-logs-prod") ? b64(SOURCE_JSON) : "[404] not found",
			gitlab_create_branch: () => "[201] {}",
			gitlab_commit_file: (a) => {
				committed.content = String(a.content);
				return "[201] {}";
			},
		});
		const { proposeIlmChange } = await import("./nodes.ts");
		const out = await proposeIlmChange(asIacState({}), {
			workflow: "ilm-rollout",
			isProd: false,
			cluster: "us-cld",
			policyName: "logs@lifecycle",
			sourcePolicy: "us-default-lifecycle-logs-prod",
			phasesPatch: { delete: { min_age: "60d" } },
		});
		expect(out.blockedReason).toBeFalsy();
		const policy = JSON.parse(committed.content ?? "{}");
		expect(policy.name).toBe("logs@lifecycle");
		expect(policy.frozen.searchable_snapshot.snapshot_repository).toBe("found-snapshots");
		expect(policy.warm.allocate.number_of_replicas).toBe(0);
		expect(policy.delete.min_age).toBe("60d");
	});

	test("blocks when the source policy can't be read (404)", async () => {
		mockBridge({ gitlab_get_file_content: () => "[404] not found" });
		const { proposeIlmChange } = await import("./nodes.ts");
		const out = await proposeIlmChange(asIacState({}), {
			workflow: "ilm-rollout",
			isProd: false,
			cluster: "us-cld",
			policyName: "logs@lifecycle",
			sourcePolicy: "does-not-exist",
		});
		expect(out.blockedReason).toBeTruthy();
		expect(String(out.messages?.[0]?.content)).toContain("does-not-exist");
	});

	test("blocks (does not throw) when the source policy is readable but malformed JSON", async () => {
		mockBridge({
			gitlab_get_file_content: () =>
				`[200] ${JSON.stringify({ content: Buffer.from('{ "name": "x", "hot": { , }').toString("base64"), encoding: "base64" })}`,
		});
		const { proposeIlmChange } = await import("./nodes.ts");
		const out = await proposeIlmChange(asIacState({}), {
			workflow: "ilm-rollout",
			isProd: false,
			cluster: "us-cld",
			policyName: "logs@lifecycle",
			sourcePolicy: "broken-policy",
		});
		expect(out.blockedReason).toBeTruthy();
		expect(String(out.blockedReason)).toContain("not valid JSON");
	});
});

// SIO-983: live-parity. The repo SOURCE policy has drifted from the live cluster (it carries warm
// forcemerge/shrink + delete.wait_for_snapshot that live lacks). A copy carries that drift forward
// silently; proposeIlmChange must read the live SOURCE policy, diff it against the draft, and surface
// the extra fields on state.liveParity; reviewPlan then adds the HIGH risk line.
describe("proposeIlmChange live-parity (SIO-983)", () => {
	// Raw ES _ilm/policy shape for the SOURCE policy's LIVE state -- a lean hot->warm->delete policy
	// WITHOUT forcemerge/shrink/wait_for_snapshot (the user's "cost-optimised, no extra phases" case).
	const LIVE_SOURCE_RAW = `[200] ${JSON.stringify({
		"us-default-lifecycle-logs-prod": {
			version: 5,
			modified_date: "2026-06-15T07:32:11.079Z",
			policy: {
				phases: {
					hot: {
						min_age: "0ms",
						actions: { rollover: { max_age: "7d", max_primary_shard_size: "10gb" }, set_priority: { priority: 100 } },
					},
					warm: { min_age: "6h", actions: { set_priority: { priority: 50 }, allocate: { number_of_replicas: 0 } } },
					cold: { min_age: "2d", actions: { set_priority: { priority: 25 }, allocate: { number_of_replicas: 0 } } },
					frozen: {
						min_age: "7d",
						actions: { searchable_snapshot: { snapshot_repository: "found-snapshots", force_merge_index: true } },
					},
					delete: { min_age: "60d", actions: { delete: { delete_searchable_snapshot: true } } },
				},
			},
		},
	})}`;

	test("flags the drifted forcemerge/shrink/wait_for_snapshot copied from a stale repo source", async () => {
		mockBridge({
			// The REPO source carries the extra phases (SOURCE_JSON has warm.forcemerge, warm.shrink,
			// delete.wait_for_snapshot); the target file 404s (new copy).
			gitlab_get_file_content: (a) =>
				String(a.filePath).includes("us-default-lifecycle-logs-prod") ? b64(SOURCE_JSON) : "[404] not found",
			gitlab_create_branch: () => "[201] {}",
			gitlab_commit_file: () => "[201] {}",
			// The LIVE source policy lacks those extra phases.
			elastic_ilm_get_lifecycle: () => LIVE_SOURCE_RAW,
		});
		const { proposeIlmChange, reviewPlan } = await import("./nodes.ts");
		const out = await proposeIlmChange(asIacState({}), {
			workflow: "ilm-rollout",
			isProd: false,
			cluster: "us-cld",
			policyName: "logs@lifecycle",
			sourcePolicy: "us-default-lifecycle-logs-prod",
		});
		expect(out.blockedReason).toBeFalsy();
		expect(out.liveParity).toBeTruthy();
		const parity = out.liveParity ?? "";
		expect(parity).toContain("Differs from live cluster");
		expect(parity).toContain("warm.forcemerge.max_num_segments");
		expect(parity).toContain("warm.shrink.number_of_shards");
		expect(parity).toContain("delete.wait_for_snapshot.policy");
		expect(parity).toContain("not in live");

		// reviewPlan surfaces the HIGH risk line (first) when the draft has fields not in live.
		const review = await reviewPlan(
			asIacState({
				iacRequest: {
					workflow: "ilm-rollout",
					isProd: false,
					cluster: "us-cld",
					policyName: "logs@lifecycle",
					sourcePolicy: "us-default-lifecycle-logs-prod",
				},
				branch: "agent/x",
				proposedDiff: out.proposedDiff ?? "",
				proposedFiles: out.proposedFiles ?? [],
				policyCreated: out.policyCreated ?? true,
				liveParity: out.liveParity,
			}),
		);
		expect(review.planReview?.liveParity).toBe(out.liveParity);
		expect(review.planReview?.risks?.[0]).toContain("not present in the LIVE cluster");
	});

	test("no advisory when the deployment's live policy can't be read (not connected)", async () => {
		mockBridge({
			gitlab_get_file_content: (a) =>
				String(a.filePath).includes("us-default-lifecycle-logs-prod") ? b64(SOURCE_JSON) : "[404] not found",
			gitlab_create_branch: () => "[201] {}",
			gitlab_commit_file: () => "[201] {}",
			// Deployment not wired into this MCP session -> placeholder -> parseEsIlmPolicyResponse null.
			elastic_ilm_get_lifecycle: () => "[cluster 'us-cld' not configured: set ELASTIC_IAC_CLUSTER_DEPLOYMENTS ...]",
		});
		const { proposeIlmChange } = await import("./nodes.ts");
		const out = await proposeIlmChange(asIacState({}), {
			workflow: "ilm-rollout",
			isProd: false,
			cluster: "us-cld",
			policyName: "logs@lifecycle",
			sourcePolicy: "us-default-lifecycle-logs-prod",
		});
		expect(out.blockedReason).toBeFalsy();
		expect(out.liveParity).toBe(""); // no live equivalent -> no advisory, no block
	});
});

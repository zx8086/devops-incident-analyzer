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
});

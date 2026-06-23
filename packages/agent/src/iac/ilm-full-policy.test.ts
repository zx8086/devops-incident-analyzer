// agent/src/iac/ilm-full-policy.test.ts
// SIO-1001: an AUTHORITATIVE full-body onboard. The user pastes a complete policy JSON and says
// "exactly these keys / do not add warm/cold/frozen". parseIntent emits ilmFullPolicy; for a
// from-scratch (404) policy commitOneIlmPolicy uses it VERBATIM instead of copying a sibling base,
// so absent phases stay absent. Mirrors the mocking pattern in ilm-copy.test.ts.
import { describe, expect, mock, test } from "bun:test";
import { parseIntentJson } from "./nodes.ts";
import type { IacStateType } from "./state.ts";

const asIacState = (partial: Partial<IacStateType>): IacStateType => partial as unknown as IacStateType;

// A 5-phase tiered sibling already in the cluster's lifecycle-policies/ dir -- the shape the old
// copy-then-merge path would have bled into a hot+delete-only onboard.
const SIBLING_JSON = JSON.stringify({
	name: "basic-lifecycle-logs",
	hot: { priority: 100, max_age: "7d", max_primary_shard_size: "10gb", rollover: true },
	warm: { min_age: "1d", priority: 50, allocate: { number_of_replicas: 0 }, forcemerge: { max_num_segments: 1 } },
	cold: { min_age: "2d", priority: 25, allocate: { number_of_replicas: 0 } },
	frozen: { min_age: "7d", searchable_snapshot: { snapshot_repository: "found-snapshots", force_merge_index: true } },
	delete: { min_age: "60d", delete_searchable_snapshot: true, wait_for_snapshot: { policy: "cloud-snapshot-policy" } },
});

// The user's authoritative hot+delete-only body (the screenshot case).
const FULL_BODY = {
	name: "logs",
	hot: { priority: 100, max_age: "30d", max_primary_shard_size: "50gb", rollover: true },
	delete: {
		min_age: "60d",
		delete_searchable_snapshot: true,
		wait_for_snapshot: { policy: "cloud-snapshot-policy" },
	},
};

const b64 = (s: string) =>
	`[200] ${JSON.stringify({ content: Buffer.from(s).toString("base64"), encoding: "base64" })}`;

const SIBLING_TREE = `[200] ${JSON.stringify([{ name: "basic-lifecycle-logs.json", type: "blob" }])}`;

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

describe("parseIntentJson ilmFullPolicy (SIO-1001)", () => {
	test("lifts a full authoritative body and leaves phasesPatch/sourcePolicy null", () => {
		const req = parseIntentJson(
			JSON.stringify({
				workflow: "ilm-rollout",
				cluster: "us-cld",
				policyName: "logs",
				ilmFullPolicy: FULL_BODY,
			}),
		);
		expect(req.ilmFullPolicy).toEqual(FULL_BODY);
		expect(req.phasesPatch).toBeUndefined();
		expect(req.sourcePolicy).toBeUndefined();
	});

	test("ilmFullPolicy is undefined for a plain phasesPatch change", () => {
		const req = parseIntentJson(
			JSON.stringify({
				workflow: "ilm-rollout",
				cluster: "us-cld",
				policyName: "logs",
				phasesPatch: { delete: { min_age: "60d" } },
			}),
		);
		expect(req.ilmFullPolicy).toBeUndefined();
	});
});

describe("proposeIlmChange authoritative full-body (SIO-1001)", () => {
	test("from-scratch onboard commits EXACTLY the provided phases -- no sibling warm/cold/frozen", async () => {
		const committed: { content?: string } = {};
		mockBridge({
			// The target policy 404s (new file); the sibling exists (would be the old copy base).
			gitlab_get_file_content: (a) =>
				String(a.filePath).includes("basic-lifecycle-logs") ? b64(SIBLING_JSON) : "[404] not found",
			gitlab_get_repository_tree: () => SIBLING_TREE,
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
			policyName: "logs",
			ilmFullPolicy: FULL_BODY,
		});
		expect(out.blockedReason).toBeFalsy();
		const policy = JSON.parse(committed.content ?? "{}");
		// Exactly name + hot + delete -- nothing else.
		expect(Object.keys(policy).sort()).toEqual(["delete", "hot", "name"]);
		expect(policy.warm).toBeUndefined();
		expect(policy.cold).toBeUndefined();
		expect(policy.frozen).toBeUndefined();
		expect(policy.name).toBe("logs");
		expect(policy.hot.max_age).toBe("30d");
		expect(policy.delete.min_age).toBe("60d");
		expect(out.policyCreated).toBe(true);
	});

	test("a from-scratch phasesPatch onboard (no full body) still inherits the tiered sibling shape", async () => {
		const committed: { content?: string } = {};
		mockBridge({
			gitlab_get_file_content: (a) =>
				String(a.filePath).includes("basic-lifecycle-logs") ? b64(SIBLING_JSON) : "[404] not found",
			gitlab_get_repository_tree: () => SIBLING_TREE,
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
			policyName: "newlogs",
			phasesPatch: { delete: { min_age: "90d" } },
		});
		expect(out.blockedReason).toBeFalsy();
		const policy = JSON.parse(committed.content ?? "{}");
		// Unchanged behavior: the sibling's tiered phases are present.
		expect(policy.warm).toBeDefined();
		expect(policy.cold).toBeDefined();
		expect(policy.frozen).toBeDefined();
		expect(policy.delete.min_age).toBe("90d");
	});

	test("the authoritative subset-phase body passes the structural validator", async () => {
		const { validateIlmPolicy } = await import("./nodes.ts");
		expect(validateIlmPolicy(FULL_BODY)).toEqual({ ok: true });
	});
});

// SIO-1011: the per-entry analogue. A single prompt onboarding >=2 NEW policies with full bodies
// (and "do not copy from live") must parse into ilmPolicies[] with each entry's ilmFullPolicy
// preserved, and proposeIlmChanges must commit BOTH files verbatim onto ONE branch -- not block.
const METRICBEAT_BODY = {
	name: "metricbeat",
	hot: { max_age: "1d", max_primary_shard_size: "2gb", priority: 100, rollover: true },
	delete: { min_age: "3d", delete_searchable_snapshot: true },
};
const ELASTIC_CLOUD_LOGS_BODY = {
	name: "elastic-cloud-logs",
	hot: { max_age: "1d", max_primary_shard_size: "2gb", priority: 100, rollover: true },
	delete: { min_age: "3d", delete_searchable_snapshot: true },
};

describe("parseIntentJson multi-file ilmFullPolicy (SIO-1011)", () => {
	test("preserves per-entry ilmFullPolicy through the >=2 fold and nulls the singular full body", () => {
		const req = parseIntentJson(
			JSON.stringify({
				workflow: "ilm-rollout",
				cluster: "eu-cld-monitor",
				ilmPolicies: [
					{ policyName: "metricbeat", ilmFullPolicy: METRICBEAT_BODY },
					{ policyName: "elastic-cloud-logs", ilmFullPolicy: ELASTIC_CLOUD_LOGS_BODY },
				],
			}),
		);
		expect(req.ilmPolicies?.length).toBe(2);
		expect(req.ilmPolicies?.[0]?.ilmFullPolicy).toEqual(METRICBEAT_BODY);
		expect(req.ilmPolicies?.[1]?.ilmFullPolicy).toEqual(ELASTIC_CLOUD_LOGS_BODY);
		// A multi-entry request never carries a singular full body.
		expect(req.ilmFullPolicy).toBeUndefined();
	});

	test("a 1-entry array with ilmFullPolicy folds to the singular path (back-compat)", () => {
		const req = parseIntentJson(
			JSON.stringify({
				workflow: "ilm-rollout",
				cluster: "eu-cld-monitor",
				ilmPolicies: [{ policyName: "metricbeat", ilmFullPolicy: METRICBEAT_BODY }],
			}),
		);
		expect(req.ilmPolicies).toBeUndefined();
		expect(req.policyName).toBe("metricbeat");
		expect(req.ilmFullPolicy).toEqual(METRICBEAT_BODY);
	});
});

describe("proposeIlmChanges multi-file authoritative full-body (SIO-1011)", () => {
	test("onboards TWO new full-body policies on one branch -- exact bodies, not blocked", async () => {
		const committed: Record<string, string> = {};
		mockBridge({
			// Both target policies 404 (new files); a sibling exists but must NOT bleed in.
			gitlab_get_file_content: (a) =>
				String(a.filePath).includes("basic-lifecycle-logs") ? b64(SIBLING_JSON) : "[404] not found",
			gitlab_get_repository_tree: () => SIBLING_TREE,
			gitlab_create_branch: () => "[201] {}",
			gitlab_commit_file: (a) => {
				committed[String(a.file_path)] = String(a.content);
				return "[201] {}";
			},
		});
		const { proposeIlmChanges } = await import("./nodes.ts");
		const out = await proposeIlmChanges(asIacState({}), {
			workflow: "ilm-rollout",
			isProd: false,
			cluster: "eu-cld-monitor",
			ilmPolicies: [
				{ policyName: "metricbeat", ilmFullPolicy: METRICBEAT_BODY },
				{ policyName: "elastic-cloud-logs", ilmFullPolicy: ELASTIC_CLOUD_LOGS_BODY },
			],
		});
		expect(out.blockedReason).toBeFalsy();
		expect(out.proposedFiles?.length).toBe(2);
		expect(out.policyCreated).toBe(true);

		const paths = Object.keys(committed);
		const metricbeatPath = paths.find((p) => p.endsWith("metricbeat.json"));
		const logsPath = paths.find((p) => p.endsWith("elastic-cloud-logs.json"));
		expect(metricbeatPath).toBeDefined();
		expect(logsPath).toBeDefined();

		const metricbeat = JSON.parse(committed[metricbeatPath ?? ""] ?? "{}");
		// Exactly name + hot + delete -- no sibling warm/cold/frozen bled in.
		expect(Object.keys(metricbeat).sort()).toEqual(["delete", "hot", "name"]);
		expect(metricbeat.name).toBe("metricbeat");
		expect(metricbeat.hot.max_age).toBe("1d");
		expect(metricbeat.delete.min_age).toBe("3d");

		const logs = JSON.parse(committed[logsPath ?? ""] ?? "{}");
		expect(Object.keys(logs).sort()).toEqual(["delete", "hot", "name"]);
		expect(logs.name).toBe("elastic-cloud-logs");
	});

	test("a multi-file entry with NO patch/copy/full-body still blocks (guard intact)", async () => {
		mockBridge({
			gitlab_get_file_content: () => "[404] not found",
			gitlab_get_repository_tree: () => SIBLING_TREE,
			gitlab_create_branch: () => "[201] {}",
			gitlab_commit_file: () => "[201] {}",
		});
		const { proposeIlmChanges } = await import("./nodes.ts");
		const out = await proposeIlmChanges(asIacState({}), {
			workflow: "ilm-rollout",
			isProd: false,
			cluster: "eu-cld-monitor",
			ilmPolicies: [{ policyName: "metricbeat", ilmFullPolicy: METRICBEAT_BODY }, { policyName: "underspecified" }],
		});
		expect(out.blockedReason).toBeTruthy();
		expect(out.proposedFiles).toBeUndefined();
	});
});

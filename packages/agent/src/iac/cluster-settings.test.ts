// agent/src/iac/cluster-settings.test.ts
// SIO-994: the cluster-settings-edit workflow -- editing the cluster-level persistent/transient
// settings (environments/<dep>/cluster-settings/settings.json, the PUT _cluster/settings surface),
// distinct from cluster-defaults' per-index-template settings. Covers the flat-merge writer, the
// parseIntent mapping, the proposer flow, the danger denylist, and the unmapped-request terminate.
import { describe, expect, mock, test } from "bun:test";
import { evaluateGuards } from "./guards.ts";
import { mergeClusterSettings, parseIntentJson, summarizeClusterSettings } from "./nodes.ts";
import type { IacRequest, IacStateType } from "./state.ts";

const asIacState = (partial: Partial<IacStateType>): IacStateType => partial as unknown as IacStateType;

// The real eu-b2b shape: flat dotted keys under top-level persistent/transient blocks.
const SETTINGS = JSON.stringify(
	{
		persistent: {
			"cluster.max_shards_per_node": "1000",
			"search.max_buckets": "65536",
		},
		transient: {},
	},
	null,
	2,
);

describe("mergeClusterSettings (SIO-994)", () => {
	test("adds a new flat persistent key, preserving the others", () => {
		const { content, previous, changed } = mergeClusterSettings(SETTINGS, {
			persistentPatch: { "xpack.monitoring.collection.interval": "60s" },
		});
		expect(changed).toBe(true);
		const obj = JSON.parse(content) as { persistent: Record<string, string>; transient: Record<string, string> };
		expect(obj.persistent["xpack.monitoring.collection.interval"]).toBe("60s");
		// untouched keys survive
		expect(obj.persistent["cluster.max_shards_per_node"]).toBe("1000");
		expect(obj.persistent["search.max_buckets"]).toBe("65536");
		// previous value of a pure ADD is undefined
		expect(previous.persistent["xpack.monitoring.collection.interval"]).toBeUndefined();
	});

	test("overwrites an existing key and records its previous value", () => {
		const { content, previous, changed } = mergeClusterSettings(SETTINGS, {
			persistentPatch: { "cluster.max_shards_per_node": "2000" },
		});
		expect(changed).toBe(true);
		expect(
			(JSON.parse(content) as { persistent: Record<string, string> }).persistent["cluster.max_shards_per_node"],
		).toBe("2000");
		expect(previous.persistent["cluster.max_shards_per_node"]).toBe("1000");
	});

	test("merges a transient patch into the transient block", () => {
		const { content, changed } = mergeClusterSettings(SETTINGS, {
			transientPatch: { "indices.recovery.max_bytes_per_sec": "200mb" },
		});
		expect(changed).toBe(true);
		expect(
			(JSON.parse(content) as { transient: Record<string, string> }).transient["indices.recovery.max_bytes_per_sec"],
		).toBe("200mb");
	});

	test("no-op when the key already has the requested value (changed=false)", () => {
		expect(mergeClusterSettings(SETTINGS, { persistentPatch: { "search.max_buckets": "65536" } }).changed).toBe(false);
	});

	test("preserves 2-space indent + trailing newline", () => {
		const { content } = mergeClusterSettings(SETTINGS, { persistentPatch: { "search.max_buckets": "131072" } });
		expect(content.endsWith("}\n")).toBe(true);
		expect(content).toContain('\n  "persistent"');
	});

	// SIO-996: explicit key removal (revert), distinct from set-to-null.
	test("removes a persistent key entirely (not set to null)", () => {
		const { content, previous, changed } = mergeClusterSettings(SETTINGS, {
			removeKeysPersistent: ["search.max_buckets"],
		});
		expect(changed).toBe(true);
		const obj = JSON.parse(content) as { persistent: Record<string, string> };
		expect("search.max_buckets" in obj.persistent).toBe(false); // gone, not null
		expect(obj.persistent["cluster.max_shards_per_node"]).toBe("1000"); // others survive
		expect(previous.persistent["search.max_buckets"]).toBe("65536"); // pre-delete value captured
	});

	test("removing an absent key is a no-op (changed=false)", () => {
		const { changed } = mergeClusterSettings(SETTINGS, {
			removeKeysPersistent: ["xpack.monitoring.collection.interval"],
		});
		expect(changed).toBe(false);
	});

	test("set + remove in one merge: both reflected, others preserved", () => {
		const { content, changed } = mergeClusterSettings(SETTINGS, {
			persistentPatch: { "indices.breaker.request.limit": "40%" },
			removeKeysPersistent: ["search.max_buckets"],
		});
		expect(changed).toBe(true);
		const obj = JSON.parse(content) as { persistent: Record<string, string> };
		expect(obj.persistent["indices.breaker.request.limit"]).toBe("40%");
		expect("search.max_buckets" in obj.persistent).toBe(false);
		expect(obj.persistent["cluster.max_shards_per_node"]).toBe("1000");
	});

	test("throws on a non-object JSON", () => {
		expect(() => mergeClusterSettings("[]", { persistentPatch: { a: "b" } })).toThrow("not an object");
	});
});

describe("parseIntentJson — cluster-settings-edit (SIO-994)", () => {
	test("maps a persistentPatch request to cluster-settings-edit", () => {
		const req = parseIntentJson(
			JSON.stringify({
				workflow: "cluster-settings-edit",
				cluster: "eu-b2b",
				persistentPatch: { "xpack.monitoring.collection.interval": "60s" },
				isProd: false,
			}),
		);
		expect(req.workflow).toBe("cluster-settings-edit");
		expect(req.cluster).toBe("eu-b2b");
		expect(req.persistentPatch).toEqual({ "xpack.monitoring.collection.interval": "60s" });
	});

	// SIO-996: a removal request maps to removeKeysPersistent, not a null-valued patch.
	test("maps a removeKeysPersistent request", () => {
		const req = parseIntentJson(
			JSON.stringify({
				workflow: "cluster-settings-edit",
				cluster: "eu-b2b",
				removeKeysPersistent: ["xpack.monitoring.collection.interval"],
				isProd: false,
			}),
		);
		expect(req.workflow).toBe("cluster-settings-edit");
		expect(req.removeKeysPersistent).toEqual(["xpack.monitoring.collection.interval"]);
		expect(req.persistentPatch).toBeUndefined();
	});
});

// SIO-996: the descriptor that makes the plan-review title (and so the live card, the durable
// iac-change fact, and its recall) say WHAT changed instead of just "cluster-settings-edit".
describe("summarizeClusterSettings (SIO-996)", () => {
	const asReq = (partial: Partial<IacRequest>): IacRequest => partial as unknown as IacRequest;

	test("names a removed persistent key", () => {
		const req = asReq({ removeKeysPersistent: ["xpack.monitoring.collection.interval"] });
		expect(summarizeClusterSettings(req)).toBe("removed xpack.monitoring.collection.interval");
	});

	test("names a set key as k=v", () => {
		const req = asReq({ persistentPatch: { "cluster.max_shards_per_node": "2000" } });
		expect(summarizeClusterSettings(req)).toBe("set cluster.max_shards_per_node=2000");
	});

	test("combines set + removed across both blocks", () => {
		const req = asReq({
			persistentPatch: { "cluster.max_shards_per_node": "2000" },
			removeKeysTransient: ["search.max_buckets"],
		});
		expect(summarizeClusterSettings(req)).toBe("set cluster.max_shards_per_node=2000; removed search.max_buckets");
	});

	test("falls back to 'change' when nothing is named", () => {
		expect(summarizeClusterSettings(asReq({}))).toBe("change");
	});

	// The descriptor must reach the plan-review title -- that single field feeds the live "check my MR"
	// card, the durable iac-change fact (buildIacChangeDecision), and recallIacChangeIntent.
	test("flows into planReview.title via reviewPlan", async () => {
		const { reviewPlan } = await import("./nodes.ts");
		mock.module("../mcp-bridge.ts", () => ({ getToolsForDataSource: () => [], getConnectedServers: () => [] }));
		const state = {
			iacRequest: {
				workflow: "cluster-settings-edit" as const,
				isProd: false,
				cluster: "eu-b2b",
				removeKeysPersistent: ["xpack.monitoring.collection.interval"],
			},
			branch: "agent/eu-b2b-cluster-settings-edit-20260621",
			proposedFiles: ["environments/eu-b2b/cluster-settings/settings.json"],
			proposedDiff: "diff",
			precheckPassed: true,
		};
		const result = await reviewPlan(asIacState(state));
		expect(result.planReview?.title).toBe(
			"[eu-b2b] removed xpack.monitoring.collection.interval: cluster-settings-edit",
		);
	});
});

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

describe("draftChange -> proposeClusterSettingsChange (SIO-994)", () => {
	const fileResult = `[200] ${JSON.stringify({ content: Buffer.from(SETTINGS).toString("base64"), encoding: "base64" })}`;

	test("happy path: creates the branch, merges the persistent setting, commits to cluster-settings/settings.json", async () => {
		const { draftChange } = await import("./nodes.ts");
		const committed: Record<string, unknown> = {};
		const branchCreated: Record<string, unknown> = {};
		mockTools({
			gitlab_get_file_content: () => fileResult,
			gitlab_create_branch: (args) => {
				Object.assign(branchCreated, args);
				return "[201] {}";
			},
			gitlab_commit_file: (args) => {
				Object.assign(committed, args);
				return "[201] {}";
			},
		});
		const state = {
			iacRequest: {
				workflow: "cluster-settings-edit" as const,
				isProd: false,
				cluster: "eu-b2b",
				persistentPatch: { "xpack.monitoring.collection.interval": "60s" },
			},
		};
		const result = await draftChange(asIacState(state));
		expect(result.precheckPassed).toBe(true);
		expect(result.proposedFilePath).toBe("environments/eu-b2b/cluster-settings/settings.json");
		// SIO-994 regression guard: the branch MUST be created before the commit (gitlab_commit_file
		// commits onto an existing branch; without create_branch the commit 400s).
		expect(branchCreated.branch).toBe(result.branch);
		expect(committed.branch).toBe(result.branch);
		expect(committed.file_path).toBe("environments/eu-b2b/cluster-settings/settings.json");
		const written = JSON.parse(String(committed.content)) as { persistent: Record<string, string> };
		expect(written.persistent["xpack.monitoring.collection.interval"]).toBe("60s");
		// other persistent keys untouched
		expect(written.persistent["cluster.max_shards_per_node"]).toBe("1000");
	});

	test("blocks when no persistent/transient patch is given", async () => {
		const { draftChange } = await import("./nodes.ts");
		mockTools({});
		const state = {
			iacRequest: { workflow: "cluster-settings-edit" as const, isProd: false, cluster: "eu-b2b" },
		};
		const result = await draftChange(asIacState(state));
		expect(result.blockedReason).toContain("at least one persistent or transient setting");
	});

	// SIO-996: a remove-only request commits the file with the key gone.
	test("happy path: removes the persistent key and commits the file without it", async () => {
		const { draftChange } = await import("./nodes.ts");
		const committed: Record<string, unknown> = {};
		mockTools({
			gitlab_get_file_content: () => fileResult,
			gitlab_create_branch: () => "[201] {}",
			gitlab_commit_file: (args) => {
				Object.assign(committed, args);
				return "[201] {}";
			},
		});
		const state = {
			iacRequest: {
				workflow: "cluster-settings-edit" as const,
				isProd: false,
				cluster: "eu-b2b",
				removeKeysPersistent: ["search.max_buckets"],
			},
		};
		const result = await draftChange(asIacState(state));
		expect(result.precheckPassed).toBe(true);
		const written = JSON.parse(String(committed.content)) as { persistent: Record<string, string> };
		expect("search.max_buckets" in written.persistent).toBe(false);
		expect(written.persistent["cluster.max_shards_per_node"]).toBe("1000");
		// removed key shows in the commit message with a leading `-`
		expect(String(committed.commit_message)).toContain("-search.max_buckets");
	});

	// SIO-996: removing an absent key is a no-op -- no MR, and (regression) no stray branch.
	test("blocks a no-op remove (the key is already absent) without creating a branch", async () => {
		const { draftChange } = await import("./nodes.ts");
		let branchCreated = false;
		mockTools({
			gitlab_get_file_content: () => fileResult,
			gitlab_create_branch: () => {
				branchCreated = true;
				return "[201] {}";
			},
		});
		const state = {
			iacRequest: {
				workflow: "cluster-settings-edit" as const,
				isProd: false,
				cluster: "eu-b2b",
				removeKeysPersistent: ["xpack.monitoring.collection.interval"],
			},
		};
		const result = await draftChange(asIacState(state));
		expect(result.blockedReason).toContain("already match the request");
		expect(branchCreated).toBe(false);
	});

	test("blocks (no create) on 404 — the settings file must already exist", async () => {
		const { draftChange } = await import("./nodes.ts");
		mockTools({ gitlab_get_file_content: () => '[404] {"message":"404 File Not Found"}' });
		const state = {
			iacRequest: {
				workflow: "cluster-settings-edit" as const,
				isProd: false,
				cluster: "nope",
				persistentPatch: { "search.max_buckets": "131072" },
			},
		};
		const result = await draftChange(asIacState(state));
		expect(result.blockedReason).toContain("not found");
	});

	test("blocks a no-op (the setting already has the requested value)", async () => {
		const { draftChange } = await import("./nodes.ts");
		mockTools({ gitlab_get_file_content: () => fileResult, gitlab_create_branch: () => "[201] {}" });
		const state = {
			iacRequest: {
				workflow: "cluster-settings-edit" as const,
				isProd: false,
				cluster: "eu-b2b",
				persistentPatch: { "search.max_buckets": "65536" },
			},
		};
		const result = await draftChange(asIacState(state));
		expect(result.blockedReason).toContain("already match the request");
	});
});

describe("evaluateGuards — cluster-settings danger denylist (SIO-994)", () => {
	const base = (persistentPatch: Record<string, unknown>): IacRequest =>
		({ workflow: "cluster-settings-edit", cluster: "eu-b2b", isProd: false, persistentPatch }) as IacRequest;

	test("blocks halting cluster-wide shard allocation", () => {
		const r = evaluateGuards(base({ "cluster.routing.allocation.enable": "none" }), null);
		expect(r.blocked).toBe(true);
		expect(r.reason).toContain("halts shard allocation");
	});

	test("blocks a cluster-wide read-only block", () => {
		const r = evaluateGuards(base({ "cluster.blocks.read_only": true }), null);
		expect(r.blocked).toBe(true);
		expect(r.reason).toContain("read-only");
	});

	test("blocks changing the flood-stage disk watermark", () => {
		const r = evaluateGuards(base({ "cluster.routing.allocation.disk.watermark.flood_stage": "99%" }), null);
		expect(r.blocked).toBe(true);
		expect(r.reason).toContain("flood-stage");
	});

	test("allows an ordinary persistent setting (e.g. the monitoring interval)", () => {
		const r = evaluateGuards(base({ "xpack.monitoring.collection.interval": "60s" }), null);
		expect(r.blocked).toBe(false);
	});
});

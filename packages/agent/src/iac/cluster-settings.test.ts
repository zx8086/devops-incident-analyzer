// agent/src/iac/cluster-settings.test.ts
// SIO-994: the cluster-settings-edit workflow -- editing the cluster-level persistent/transient
// settings (environments/<dep>/cluster-settings/settings.json, the PUT _cluster/settings surface),
// distinct from cluster-defaults' per-index-template settings. Covers the flat-merge writer, the
// parseIntent mapping, the proposer flow, the danger denylist, and the unmapped-request terminate.
import { describe, expect, mock, test } from "bun:test";
import { evaluateGuards } from "./guards.ts";
import { mergeClusterSettings, parseIntentJson } from "./nodes.ts";
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

	test("happy path: merges the persistent setting, commits to cluster-settings/settings.json", async () => {
		const { draftChange } = await import("./nodes.ts");
		let committed: Record<string, unknown> = {};
		mockTools({
			gitlab_get_file_content: () => fileResult,
			gitlab_create_branch: () => "[201] {}",
			gitlab_commit_file: (args) => {
				committed = args;
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
		expect(result.blockedReason).toContain("already have the requested values");
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

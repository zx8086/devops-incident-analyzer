// agent/src/iac/version-upgrade.test.ts
import { describe, expect, test } from "bun:test";
import { mrIidFromConflictMessage } from "./mr-live-state.ts";
import {
	applyLiveTopology,
	branchSlug,
	classifyCreateMrResult,
	deploymentJsonPath,
	extractMrUrl,
	isUnchangedConfig,
	parseIntentJson,
	setDeploymentTierSize,
	setDeploymentVersion,
} from "./nodes.ts";

// SIO-871: an upgrade request with both cluster and target version must parse to a
// version-upgrade workflow with NO clarification, so it flows straight to the HITL
// plan-review gate instead of asking a redundant question.
describe("parseIntentJson — version-upgrade", () => {
	test("extracts workflow/cluster/version and does not clarify", () => {
		const raw = JSON.stringify({ workflow: "version-upgrade", cluster: "ap-cld", version: "9.4.2" });
		const req = parseIntentJson(raw);
		expect(req.workflow).toBe("version-upgrade");
		expect(req.cluster).toBe("ap-cld");
		expect(req.version).toBe("9.4.2");
		expect(req.clarification).toBeUndefined();
	});

	test("keeps a clarification when the planner emits one (e.g. no concrete version)", () => {
		const raw = JSON.stringify({
			workflow: "version-upgrade",
			cluster: "ap-cld",
			clarification: "Which target version should I upgrade ap-cld to?",
		});
		const req = parseIntentJson(raw);
		expect(req.workflow).toBe("version-upgrade");
		expect(req.clarification).toContain("target version");
	});

	test("malformed output falls back to the safe clarify default", () => {
		const req = parseIntentJson("not json at all");
		expect(req.workflow).toBe("other");
		expect(req.clarification).toBeDefined();
	});

	// Regression: the planner emits explicit null for absent optional fields (and often
	// wraps the object in a ```json fence). Both must parse, not hit the clarify fallback.
	test("tolerates explicit nulls and a json code fence", () => {
		const raw =
			'```json\n{"workflow":"version-upgrade","cluster":"ap-cld","tier":null,"newSizeGb":null,"version":"9.4.2","reason":null,"isProd":true,"clarification":null}\n```';
		const req = parseIntentJson(raw);
		expect(req.workflow).toBe("version-upgrade");
		expect(req.cluster).toBe("ap-cld");
		expect(req.version).toBe("9.4.2");
		expect(req.tier).toBeUndefined();
		expect(req.clarification).toBeUndefined();
	});
});

describe("branchSlug", () => {
	test("uses the target version as the descriptor for an upgrade", () => {
		expect(branchSlug({ workflow: "version-upgrade", cluster: "ap-cld", version: "9.4.2", isProd: false })).toBe(
			"ap-cld-9-4-2-version-upgrade",
		);
	});

	test("uses tier/resource for a tier-resize", () => {
		expect(branchSlug({ workflow: "tier-resize", cluster: "eu-b2b", tier: "warm", isProd: false })).toBe(
			"eu-b2b-warm-tier-resize",
		);
	});
});

// SIO-873: the GitOps proposer edits the deployment JSON .version (full file content,
// not a diff) and commits via the GitLab API. setDeploymentVersion is the read-modify-write.
describe("setDeploymentVersion", () => {
	test("sets .version, returns the previous, preserves other fields", () => {
		const input = JSON.stringify({ name: "ap-cld", version: "9.4.1", region: "ap-east-1" }, null, 2);
		const out = setDeploymentVersion(input, "9.4.2");
		expect(out.previous).toBe("9.4.1");
		const parsed = JSON.parse(out.content);
		expect(parsed.version).toBe("9.4.2");
		expect(parsed.name).toBe("ap-cld");
		expect(parsed.region).toBe("ap-east-1");
	});

	test("re-serializes with 2-space indent and a trailing newline", () => {
		const out = setDeploymentVersion('{"version":"9.4.0"}', "9.4.2");
		expect(out.content.endsWith("}\n")).toBe(true);
		expect(out.content).toContain('  "version": "9.4.2"');
	});

	test("previous is undefined when the field was absent", () => {
		const out = setDeploymentVersion('{"name":"x"}', "9.4.2");
		expect(out.previous).toBeUndefined();
		expect(JSON.parse(out.content).version).toBe("9.4.2");
	});

	test("throws on non-object / invalid JSON", () => {
		expect(() => setDeploymentVersion("not json", "9.4.2")).toThrow();
		expect(() => setDeploymentVersion("[1,2,3]", "9.4.2")).toThrow("not an object");
	});
});

// No-op guard for the GitOps proposers: an edit that re-serializes to the current file
// must short-circuit before opening an empty-diff MR (immediate "already at target"
// feedback). Pure helper, tested against the read-modify-write helpers it gates.
describe("isUnchangedConfig", () => {
	test("true when a version edit re-serializes to the current file", () => {
		const original = JSON.stringify({ name: "ap-cld", version: "9.4.2", region: "ap-east-1" }, null, 2);
		expect(isUnchangedConfig(setDeploymentVersion(original, "9.4.2").content, original)).toBe(true);
	});

	test("false for a real version bump", () => {
		const original = JSON.stringify({ name: "ap-cld", version: "9.4.1" }, null, 2);
		expect(isUnchangedConfig(setDeploymentVersion(original, "9.4.2").content, original)).toBe(false);
	});

	test("normalizes formatting: a compact original still reads as unchanged", () => {
		const compact = '{"name":"ap-cld","version":"9.4.2"}';
		expect(isUnchangedConfig(setDeploymentVersion(compact, "9.4.2").content, compact)).toBe(true);
	});

	test("true when a tier-resize requests the size the JSON already has", () => {
		const original = JSON.stringify(
			{ name: "eu-b2b", elasticsearch: { warm: { size: "8g", max_size: "15g", zone_count: 2 } } },
			null,
			2,
		);
		expect(isUnchangedConfig(setDeploymentTierSize(original, "warm", 8, 15).content, original)).toBe(true);
	});

	test("false when a tier-resize actually changes a size", () => {
		const original = JSON.stringify(
			{ name: "eu-b2b", elasticsearch: { warm: { size: "8g", max_size: "15g" } } },
			null,
			2,
		);
		expect(isUnchangedConfig(setDeploymentTierSize(original, "warm", 4, 15).content, original)).toBe(false);
	});

	test("false when the original is not valid JSON", () => {
		expect(isUnchangedConfig("{}\n", "not json")).toBe(false);
	});
});

describe("deploymentJsonPath", () => {
	// biome-ignore lint/suspicious/noTemplateCurlyInString: SIO-954 - ${cluster} names the literal placeholder under test
	test("substitutes the literal ${cluster} placeholder", () => {
		// biome-ignore lint/suspicious/noTemplateCurlyInString: SIO-954 - literal ${cluster} placeholder is the test input
		expect(deploymentJsonPath("environments/_deployments/${cluster}.json", "ap-cld")).toBe(
			"environments/_deployments/ap-cld.json",
		);
	});

	test("substitutes every occurrence", () => {
		// biome-ignore lint/suspicious/noTemplateCurlyInString: SIO-954 - literal ${cluster} placeholders are the test input
		expect(deploymentJsonPath("${cluster}/x/${cluster}.json", "eu-b2b")).toBe("eu-b2b/x/eu-b2b.json");
	});
});

// SIO-874: openMr must surface the merge_request web_url, not the first https in the
// JSON (which is a gravatar avatar URL).
describe("extractMrUrl", () => {
	test("returns web_url, not an earlier avatar URL in the body", () => {
		const body =
			'[201] {"author":{"avatar_url":"https://secure.gravatar.com/avatar/abc?s=80"},' +
			'"web_url":"https://gitlab.com/pvhcorp/dhco/observability/observability-elastic-iac/-/merge_requests/40","iid":40}';
		expect(extractMrUrl(body)).toBe(
			"https://gitlab.com/pvhcorp/dhco/observability/observability-elastic-iac/-/merge_requests/40",
		);
	});

	// SIO-1062: null (never the raw result) when web_url is absent -- returning the raw body
	// let a "[409] {...}" GitLab error blob be stored as mrUrl.
	test("returns null when web_url is absent / unparseable", () => {
		expect(extractMrUrl('[400] {"message":"boom"}')).toBeNull();
		expect(extractMrUrl("[gitlab token not configured]")).toBeNull();
		expect(
			extractMrUrl('[409] {"message":["Another open merge request already exists for this source branch: !256"]}'),
		).toBeNull();
	});
});

// SIO-1062: classify gitlab_create_merge_request's "[status] body" so openMr never stores an
// error body as mrUrl (409 -> reuse the existing MR; other 4xx/5xx and url-less bodies -> block).
describe("classifyCreateMrResult (SIO-1062)", () => {
	test("2xx with web_url -> created with url + iid", () => {
		const body = '[201] {"web_url":"https://gitlab.com/group/repo/-/merge_requests/41","iid":41}';
		expect(classifyCreateMrResult(body)).toEqual({
			kind: "created",
			url: "https://gitlab.com/group/repo/-/merge_requests/41",
			iid: 41,
		});
	});

	test("409 duplicate-MR -> conflict with the iid from the !NNN message", () => {
		const body = '[409] {"message":["Another open merge request already exists for this source branch: !256"]}';
		expect(classifyCreateMrResult(body)).toEqual({ kind: "conflict", iid: 256 });
	});

	test("409 without a !NNN reference -> conflict with null iid", () => {
		expect(classifyCreateMrResult('[409] {"message":["Conflict"]}')).toEqual({ kind: "conflict", iid: null });
	});

	test("other 4xx/5xx -> failed with the body as reason", () => {
		expect(classifyCreateMrResult('[500] {"message":"boom"}')).toEqual({
			kind: "failed",
			reason: '[500] {"message":"boom"}',
		});
		expect(classifyCreateMrResult('[403] {"message":"forbidden"}')).toEqual({
			kind: "failed",
			reason: '[403] {"message":"forbidden"}',
		});
	});

	test("callTool placeholders (no status prefix, no web_url) -> failed", () => {
		expect(classifyCreateMrResult("[gitlab token not configured]")).toEqual({
			kind: "failed",
			reason: "[gitlab token not configured]",
		});
		expect(classifyCreateMrResult("[gitlab_create_merge_request error: fetch failed]")).toEqual({
			kind: "failed",
			reason: "[gitlab_create_merge_request error: fetch failed]",
		});
	});

	test("2xx body without web_url -> failed (never a garbage url)", () => {
		expect(classifyCreateMrResult('[201] {"iid":41}')).toEqual({ kind: "failed", reason: '[201] {"iid":41}' });
	});
});

describe("mrIidFromConflictMessage (SIO-1062)", () => {
	test("extracts the bang-iid from the 409 message", () => {
		expect(
			mrIidFromConflictMessage(
				'[409] {"message":["Another open merge request already exists for this source branch: !256"]}',
			),
		).toBe(256);
	});

	test("null when there is no !NNN token", () => {
		expect(mrIidFromConflictMessage('[409] {"message":["Conflict"]}')).toBeNull();
		expect(mrIidFromConflictMessage("")).toBeNull();
	});
});

// SIO-879: tier-resize edits elasticsearch.<tier>.size/max_size (strings "<N>g").
describe("setDeploymentTierSize", () => {
	const json = JSON.stringify(
		{
			name: "eu-b2b",
			version: "9.4.1",
			elasticsearch: {
				hot: { max_size: "29g", zone_count: 3 },
				warm: { size: "8g", max_size: "15g", zone_count: 2 },
			},
		},
		null,
		2,
	);

	test("sets size + max, returns previous, preserves other tier fields", () => {
		const out = setDeploymentTierSize(json, "warm", 4, 8);
		expect(out.previousSize).toBe("8g");
		expect(out.previousMax).toBe("15g");
		const p = JSON.parse(out.content);
		expect(p.elasticsearch.warm.size).toBe("4g");
		expect(p.elasticsearch.warm.max_size).toBe("8g");
		expect(p.elasticsearch.warm.zone_count).toBe(2);
		expect(p.elasticsearch.hot.max_size).toBe("29g"); // untouched
	});

	test("sets only the field provided (autoscaling-only tier: max only)", () => {
		const out = setDeploymentTierSize(json, "hot", undefined, 20);
		const p = JSON.parse(out.content);
		expect(p.elasticsearch.hot.max_size).toBe("20g");
		expect(p.elasticsearch.hot.size).toBeUndefined();
		expect(out.previousSize).toBeUndefined();
		expect(out.previousMax).toBe("29g");
	});

	test("trailing newline + throws on unknown tier / bad JSON", () => {
		expect(setDeploymentTierSize(json, "warm", 4).content.endsWith("}\n")).toBe(true);
		expect(() => setDeploymentTierSize(json, "frozen", 4)).toThrow("unknown or unsized tier");
		expect(() => setDeploymentTierSize("not json", "warm", 4)).toThrow();
		expect(() => setDeploymentTierSize('{"name":"x"}', "warm", 4)).toThrow("no elasticsearch block");
	});
});

// SIO-879: tier-resize parses to the right fields with no clarify.
describe("parseIntentJson — tier-resize", () => {
	test("extracts tier + newSizeGb/newMaxGb", () => {
		const raw = JSON.stringify({ workflow: "tier-resize", cluster: "eu-b2b", tier: "warm", newSizeGb: 8 });
		const req = parseIntentJson(raw);
		expect(req.workflow).toBe("tier-resize");
		expect(req.tier).toBe("warm");
		expect(req.newSizeGb).toBe(8);
		expect(req.clarification).toBeUndefined();
	});
});

// reconcile-to-live: rewrite the elasticsearch block's per-tier sizing from the live topology.
describe("applyLiveTopology", () => {
	const json = JSON.stringify(
		{
			name: "eu-b2b",
			elasticsearch: {
				hot: { max_size: "29g", zone_count: 3 },
				warm: { size: "8g", max_size: "15g", zone_count: 2 },
			},
		},
		null,
		2,
	);

	test("sets max_size + zone_count from live, captures previous, leaves current size", () => {
		const out = applyLiveTopology(json, { warm: { sizeGb: 8, zoneCount: 3 } });
		const p = JSON.parse(out.content);
		expect(p.elasticsearch.warm.max_size).toBe("8g");
		expect(p.elasticsearch.warm.zone_count).toBe(3);
		expect(p.elasticsearch.warm.size).toBe("8g"); // current size untouched
		expect(out.previous.warm).toEqual({ maxSize: "15g", zoneCount: 2 });
		expect(p.elasticsearch.hot.max_size).toBe("29g"); // untouched tier
	});

	test("never invents a tier the repo JSON lacks", () => {
		const out = applyLiveTopology(json, { frozen: { sizeGb: 4, zoneCount: 1 } });
		expect(JSON.parse(out.content).elasticsearch.frozen).toBeUndefined();
		expect(out.previous.frozen).toBeUndefined();
	});

	test("sets only the fields present in the live entry", () => {
		const out = applyLiveTopology(json, { hot: { zoneCount: 2 } });
		const p = JSON.parse(out.content);
		expect(p.elasticsearch.hot.zone_count).toBe(2);
		expect(p.elasticsearch.hot.max_size).toBe("29g"); // sizeGb absent -> max_size unchanged
		expect(out.previous.hot).toEqual({ zoneCount: 3 });
	});

	test("records only fields that actually changed (no phantom edits)", () => {
		// hot already matches live on both fields -> not recorded at all.
		expect(applyLiveTopology(json, { hot: { sizeGb: 29, zoneCount: 3 } }).previous.hot).toBeUndefined();
		// warm: max_size differs (15g->8g) but zone_count already matches (2) -> only maxSize captured.
		const out = applyLiveTopology(json, { warm: { sizeGb: 8, zoneCount: 2 } });
		expect(out.previous.warm).toEqual({ maxSize: "15g" });
		expect(JSON.parse(out.content).elasticsearch.warm.zone_count).toBe(2);
	});

	test("trailing newline + throws on bad JSON / missing elasticsearch block", () => {
		expect(applyLiveTopology(json, { warm: { sizeGb: 4 } }).content.endsWith("}\n")).toBe(true);
		expect(() => applyLiveTopology("not json", {})).toThrow();
		expect(() => applyLiveTopology('{"name":"x"}', { warm: { sizeGb: 4 } })).toThrow("no elasticsearch block");
	});
});

import { mock } from "bun:test";
import type { IacStateType } from "./state.ts";

// SIO-1196: draftChange -- version-upgrade three-way live check. The no-op decision must be
// grounded in the LIVE deployment, not just the repo file (the us-cld 9.4.4 incident: repo said
// 9.4.4, live ran 9.4.3, agent answered "No change needed").
function mockVersionTools(handlers: Record<string, (args: Record<string, unknown>) => string>) {
	const calls: Record<string, number> = {};
	const tools = Object.entries(handlers).map(([name, fn]) => ({
		name,
		invoke: async (args: Record<string, unknown>) => {
			calls[name] = (calls[name] ?? 0) + 1;
			return fn(args);
		},
	}));
	mock.module("../mcp-bridge.ts", () => ({
		getToolsForDataSource: () => tools,
		getConnectedServers: () => ["elastic-iac-mcp"],
	}));
	return calls;
}

const vuAsState = (partial: Record<string, unknown>): IacStateType => partial as unknown as IacStateType;

const MERGE_SHA_1196 = "ab78971fbccf99841110e1d0aa98d3266cc15edc";
// The file's last_commit_id is the SQUASH commit (branch tip), NOT the merge commit -- pipelines
// run on the merge commit, so the apply lookup must go through the MR's merge_commit_sha.
const SQUASH_SHA_1196 = "f155b0673fcf6524c95c3c4a6e480d4da6e7893d";
const vuFile = (version: string): string =>
	`[200] ${JSON.stringify({
		content: Buffer.from(`{\n  "name": "us-cld",\n  "version": "${version}"\n}\n`).toString("base64"),
		encoding: "base64",
		last_commit_id: SQUASH_SHA_1196,
	})}`;
const vuLive = (version: string): string => `[200] {"resources":{"elasticsearch":[{"info":{"version":"${version}"}}]}}`;
const vuClusterState = (version: string) => ({
	cluster: "us-cld",
	summary: "us-cld healthy",
	alertsManaged: false,
	raw: vuLive(version),
});
const vuRequest = { workflow: "version-upgrade" as const, isProd: false, cluster: "us-cld", version: "9.4.4" };

describe("draftChange -- version-upgrade three-way live check (SIO-1196)", () => {
	test("repo==target AND live==target -> genuine no-op, message says verified live", async () => {
		const { draftChange } = await import("./nodes.ts");
		const calls = mockVersionTools({ gitlab_get_file_content: () => vuFile("9.4.4") });
		const result = await draftChange(vuAsState({ iacRequest: vuRequest, clusterState: vuClusterState("9.4.4") }));
		expect(result.noopReason).toBeTruthy();
		const msg = String(result.messages?.[0]?.content ?? "");
		expect(msg).toContain("verified");
		expect(msg).toContain("9.4.4");
		expect(calls.gitlab_create_branch ?? 0).toBe(0);
	});

	test("repo==target AND live!=target -> drift seeded into the drift lane, NO write tools called", async () => {
		const { draftChange } = await import("./nodes.ts");
		const applyShas: string[] = [];
		const calls = mockVersionTools({
			gitlab_get_file_content: () => vuFile("9.4.4"),
			gitlab_get_merge_commit_apply_result: (args) => {
				applyShas.push(String(args.sha));
				return '{"applyStatus":"manual","pipelineId":2698482841,"webUrl":"https://gitlab.com/x/-/jobs/15486522999","parentStatus":"success"}';
			},
			gitlab_get_commit_merge_requests: () =>
				`[200] ${JSON.stringify([
					{
						iid: 346,
						state: "merged",
						merged_at: "2026-07-22T21:49:07.000Z",
						web_url: "https://gitlab.com/x/-/merge_requests/346",
						merge_commit_sha: MERGE_SHA_1196,
					},
				])}`,
		});
		const result = await draftChange(vuAsState({ iacRequest: vuRequest, clusterState: vuClusterState("9.4.3") }));
		// The apply lookup must use the MR's merge_commit_sha, not the file's squash commit.
		expect(applyShas).toEqual([MERGE_SHA_1196]);
		expect(result.noopReason ?? "").toBe("");
		expect(result.intent).toBe("drift");
		expect(result.versionDrift).toMatchObject({
			cluster: "us-cld",
			targetVersion: "9.4.4",
			liveVersion: "9.4.3",
			mrRef: "!346",
		});
		expect(result.targetDeployment).toBe("us-cld");
		expect(result.driftReport?.stacks).toHaveLength(1);
		const stack = result.driftReport?.stacks[0];
		expect(stack?.stack).toBe("deployments");
		expect(stack?.liveReconcilable).toBe(false);
		expect(stack?.explanation).toContain("MR !346");
		expect(stack?.explanation).toContain("MANUAL");
		const msg = String(result.messages?.[0]?.content ?? "");
		expect(msg).toContain("Version drift detected");
		expect(msg).toContain("9.4.3");
		expect(calls.gitlab_create_branch ?? 0).toBe(0);
		expect(calls.gitlab_commit_file ?? 0).toBe(0);
	});

	test("repo==target AND live unknown -> no-op with repo-only caveat", async () => {
		const { draftChange } = await import("./nodes.ts");
		mockVersionTools({
			gitlab_get_file_content: () => vuFile("9.4.4"),
			elastic_cloud_list_deployments: () => "[elastic cloud request failed: timeout]",
		});
		const result = await draftChange(vuAsState({ iacRequest: vuRequest }));
		expect(result.noopReason).toBeTruthy();
		const msg = String(result.messages?.[0]?.content ?? "");
		expect(msg).toContain("REPO file only");
		expect(result.versionDrift ?? null).toBeNull();
	});

	test("repo==target AND apply currently running -> no-op says RUNNING with pipeline evidence, no drift lane", async () => {
		const { draftChange } = await import("./nodes.ts");
		mockVersionTools({
			gitlab_get_file_content: () => vuFile("9.4.4"),
			gitlab_get_merge_commit_apply_result: () =>
				'{"applyStatus":"running","pipelineId":2698484619,"webUrl":"https://gitlab.com/x/-/jobs/15509964312","parentStatus":"running"}',
			gitlab_get_commit_merge_requests: () =>
				`[200] ${JSON.stringify([{ iid: 346, state: "merged", merge_commit_sha: MERGE_SHA_1196 }])}`,
		});
		const result = await draftChange(vuAsState({ iacRequest: vuRequest, clusterState: vuClusterState("9.4.3") }));
		expect(result.noopReason).toBeTruthy();
		expect(result.versionDrift ?? null).toBeNull();
		const msg = String(result.messages?.[0]?.content ?? "");
		expect(msg).toContain("RUNNING");
		// SIO-1196 follow-up: the claim must carry its proof -- the live apply job URL, the child
		// pipeline id, and the MR it belongs to, all read from the ACTUAL pipeline via the GitLab API.
		expect(msg).toContain("MR !346");
		expect(msg).toContain("https://gitlab.com/x/-/jobs/15509964312");
		expect(msg).toContain("2698484619");
	});

	test("apply running but unverifiable (no job URL) still cites the pipeline id", async () => {
		const { draftChange } = await import("./nodes.ts");
		mockVersionTools({
			gitlab_get_file_content: () => vuFile("9.4.4"),
			gitlab_get_merge_commit_apply_result: () => '{"applyStatus":"pending","pipelineId":77,"parentStatus":"running"}',
		});
		const result = await draftChange(vuAsState({ iacRequest: vuRequest, clusterState: vuClusterState("9.4.3") }));
		expect(result.noopReason).toBeTruthy();
		expect(result.versionDrift ?? null).toBeNull();
		const msg = String(result.messages?.[0]?.content ?? "");
		expect(msg).toContain("PENDING");
		expect(msg).toContain("77");
	});

	test("repo!=target AND live==repo baseline -> normal propose, no advisory", async () => {
		const { draftChange } = await import("./nodes.ts");
		const calls = mockVersionTools({
			gitlab_get_file_content: () => vuFile("9.4.3"),
			gitlab_create_branch: () => "[201] {}",
			gitlab_commit_file: () => "[201] {}",
		});
		const result = await draftChange(vuAsState({ iacRequest: vuRequest, clusterState: vuClusterState("9.4.3") }));
		expect(result.precheckPassed).toBe(true);
		expect(calls.gitlab_create_branch).toBe(1);
		expect(result.liveParity ?? "").toBe("");
	});

	test("repo!=target AND live!=repo baseline -> propose + review-card advisory", async () => {
		const { draftChange } = await import("./nodes.ts");
		mockVersionTools({
			gitlab_get_file_content: () => vuFile("9.4.3"),
			gitlab_create_branch: () => "[201] {}",
			gitlab_commit_file: () => "[201] {}",
		});
		const result = await draftChange(vuAsState({ iacRequest: vuRequest, clusterState: vuClusterState("9.4.2") }));
		expect(result.precheckPassed).toBe(true);
		expect(result.liveParity).toContain("9.4.2");
		expect(result.liveParity).toContain("never have applied");
	});

	test("fallback: clusterState missing -> direct elastic_cloud_get_deployment read is used", async () => {
		const { draftChange } = await import("./nodes.ts");
		const calls = mockVersionTools({
			gitlab_get_file_content: () => vuFile("9.4.4"),
			elastic_cloud_list_deployments: () =>
				'[200] {"deployments":[{"id":"971a5b57d61d494ebf7bc144a5cf27b7","name":"us-cld"}]}',
			elastic_cloud_get_deployment: () => vuLive("9.4.4"),
		});
		const result = await draftChange(vuAsState({ iacRequest: vuRequest }));
		expect(result.noopReason).toBeTruthy();
		expect(calls.elastic_cloud_get_deployment).toBe(1);
		const msg = String(result.messages?.[0]?.content ?? "");
		expect(msg).toContain("verified");
	});
});

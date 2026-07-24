// packages/agent/src/iac/version-live-parity.test.ts
import { describe, expect, test } from "bun:test";
import {
	buildVersionDriftAttribution,
	buildVersionDriftStack,
	computeVersionLiveParity,
	extractLastCommitId,
	parseCommitMergeRequests,
} from "./nodes.ts";

// SIO-1196: fixtures mirror the REAL MCP shapes. Live detail = elastic_cloud_get_deployment
// "[200] {json}" body (same shape drift.test.ts uses); file read = the GitLab files API
// "[200] {json}" envelope with base64 content + last_commit_id.
const liveDetail = (version: string): string =>
	`[200] {"resources":{"elasticsearch":[{"info":{"version":"${version}","plan_info":{"current":{"plan":{"elasticsearch":{"version":"${version}"}}}}}}]}}`;

const MERGE_SHA = "ab78971fbccf99841110e1d0aa98d3266cc15edc";
const filesApiBody = (lastCommitId: string): string =>
	`[200] {"file_name":"us-cld.json","file_path":"environments/_deployments/us-cld.json","encoding":"base64","content":"${Buffer.from(
		'{"version": "9.4.4"}\n',
	).toString("base64")}","last_commit_id":"${lastCommitId}"}`;

describe("computeVersionLiveParity (SIO-1196)", () => {
	test("match when the live version equals the target", () => {
		expect(computeVersionLiveParity(liveDetail("9.4.4"), "9.4.4")).toEqual({ kind: "match" });
	});

	test("drift with the live version when it differs from the target", () => {
		expect(computeVersionLiveParity(liveDetail("9.4.3"), "9.4.4")).toEqual({
			kind: "drift",
			liveVersion: "9.4.3",
		});
	});

	test("unknown when the live detail is missing or unreadable", () => {
		expect(computeVersionLiveParity(undefined, "9.4.4")).toEqual({ kind: "unknown" });
		expect(computeVersionLiveParity("[elastic_cloud_get_deployment error: timeout]", "9.4.4")).toEqual({
			kind: "unknown",
		});
		expect(computeVersionLiveParity("[404] deployment not found", "9.4.4")).toEqual({ kind: "unknown" });
	});
});

describe("extractLastCommitId (SIO-1196)", () => {
	test("returns last_commit_id from a files-API body", () => {
		expect(extractLastCommitId(filesApiBody(MERGE_SHA))).toBe(MERGE_SHA);
	});

	test("empty when absent, non-JSON, or an error placeholder", () => {
		expect(extractLastCommitId('[200] {"file_name":"x.json","content":"e30="}')).toBe("");
		expect(extractLastCommitId("[gitlab token not configured]")).toBe("");
		expect(extractLastCommitId("[404] file not found")).toBe("");
	});
});

describe("parseCommitMergeRequests (SIO-1196)", () => {
	const mr = (over: Record<string, unknown>): string =>
		JSON.stringify([
			{
				iid: 346,
				state: "merged",
				merged_at: "2026-07-22T21:49:07.000Z",
				web_url: "https://gitlab.com/x/-/merge_requests/346",
				title: "[us-cld] 9.4.3 -> 9.4.4: version-upgrade",
				merge_commit_sha: "ab78971fbccf99841110e1d0aa98d3266cc15edc",
				...over,
			},
		]);

	test("picks the merged MR and returns iid/mergedAt/webUrl/title/mergeCommitSha", () => {
		expect(parseCommitMergeRequests(`[200] ${mr({})}`)).toEqual({
			iid: 346,
			mergedAt: "2026-07-22T21:49:07.000Z",
			webUrl: "https://gitlab.com/x/-/merge_requests/346",
			title: "[us-cld] 9.4.3 -> 9.4.4: version-upgrade",
			mergeCommitSha: "ab78971fbccf99841110e1d0aa98d3266cc15edc",
		});
	});

	test("null when no MR is merged, the list is empty, or the body errors", () => {
		expect(parseCommitMergeRequests(`[200] ${mr({ state: "opened" })}`)).toBeNull();
		expect(parseCommitMergeRequests("[200] []")).toBeNull();
		expect(parseCommitMergeRequests("[404] not found")).toBeNull();
		expect(parseCommitMergeRequests("[gitlab_get_commit_merge_requests error: boom]")).toBeNull();
	});
});

describe("buildVersionDriftAttribution (SIO-1196)", () => {
	const manualApply = {
		applyStatus: "manual",
		pipelineId: 2698482841,
		webUrl: "https://gitlab.com/x/-/jobs/15486522999",
	};
	const mr346 = {
		iid: 346,
		mergedAt: "2026-07-22T21:49:07.000Z",
		webUrl: "https://gitlab.com/x/-/merge_requests/346",
		title: "[us-cld] 9.4.3 -> 9.4.4: version-upgrade",
	};

	test("manual apply + MR names the MR, merge date, MANUAL start, and the job link", () => {
		const line = buildVersionDriftAttribution(manualApply, mr346);
		expect(line).toContain("MR !346");
		expect(line).toContain("2026-07-22");
		expect(line).toContain("MANUAL");
		expect(line).toContain("https://gitlab.com/x/-/jobs/15486522999");
	});

	test("no apply job + no MR degrades to the generic never-ran wording", () => {
		const line = buildVersionDriftAttribution({ applyStatus: "", reason: "apply job not started" }, null);
		expect(line).toContain("apply job never started");
		expect(line).not.toContain("MR !");
	});

	test("failed apply says the apply FAILED and links the job", () => {
		const line = buildVersionDriftAttribution({ applyStatus: "failed", webUrl: "https://g/j/9" }, mr346);
		expect(line).toContain("FAILED");
		expect(line).toContain("https://g/j/9");
	});

	test("null apply result degrades to the unattributable wording", () => {
		const line = buildVersionDriftAttribution(null, null);
		expect(line).toContain("could not attribute");
	});
});

describe("buildVersionDriftStack (SIO-1196)", () => {
	const stack = buildVersionDriftStack({
		cluster: "us-cld",
		repoVersion: "9.4.4",
		liveVersion: "9.4.3",
		configPath: "environments/_deployments/us-cld.json",
		attribution: "MR !346 (merged 2026-07-22) bumped the repo, but its apply job never ran.",
	});

	test("targets the deployments stack as config-json with 0/1/0 counts", () => {
		expect(stack.stack).toBe("deployments");
		expect(stack.kind).toBe("config-json");
		expect(stack.drifted).toBe(true);
		expect(stack.create).toBe(0);
		expect(stack.update).toBe(1);
		expect(stack.delete).toBe(0);
		expect(stack.configPath).toBe("environments/_deployments/us-cld.json");
	});

	test("liveReconcilable is false -- reconcile-to-live would write 9.4.3 back and undo the upgrade", () => {
		expect(stack.liveReconcilable).toBe(false);
	});

	test("resource carries before=live after=repo on the version key", () => {
		const r = stack.resources[0];
		expect(r?.address).toContain("us-cld");
		expect(r?.changedKeys).toEqual(["version"]);
		expect(r?.values?.version).toEqual({ before: "9.4.3", after: "9.4.4" });
		expect(r?.changes).toEqual([{ path: "version", op: "update", before: "9.4.3", after: "9.4.4" }]);
	});

	test("explanation embeds the attribution and the marker-MR remediation", () => {
		expect(stack.explanation).toContain("MR !346");
		expect(stack.explanation).toContain("Reconcile to GitLab");
		expect(stack.explanation).toContain("MANUAL");
	});
});

import { renderDeploymentJsonLiveParity } from "./nodes.ts";

// SIO-1196 Tier 2: repo deployment-JSON vs live EC deployment advisory for the review card.
// Non-blocking: "" when in sync or live unreadable. Must never contain the phrase "not in live"
// (reviewPlan promotes that phrase to a HIGH risk; a sizing mismatch is advisory).
describe("renderDeploymentJsonLiveParity (SIO-1196)", () => {
	const repoJson = JSON.stringify({
		name: "eu-cld",
		version: "9.4.3",
		elasticsearch: {
			warm: { size: "15g", max_size: "30g", zone_count: 3 },
			hot: { size: "60g", max_size: "120g", zone_count: 3 },
		},
	});
	const liveBody = (version: string, warmSizeMb: number, warmZones: number): string =>
		`[200] ${JSON.stringify({
			resources: {
				elasticsearch: [
					{
						info: {
							version,
							plan_info: {
								current: {
									plan: {
										cluster_topology: [
											{ id: "warm", size: { value: warmSizeMb, resource: "memory" }, zone_count: warmZones },
											{ id: "hot_content", size: { value: 122880, resource: "memory" }, zone_count: 3 },
										],
									},
								},
							},
						},
					},
				],
			},
		})}`;

	test("version mismatch renders a live-vs-repo line when includeVersion", () => {
		const out = renderDeploymentJsonLiveParity(repoJson, liveBody("9.4.2", 30720, 3), {
			includeVersion: true,
		});
		expect(out).toContain("9.4.2");
		expect(out).toContain("9.4.3");
	});

	test("named-tier max_size/zone_count mismatches render per-field lines", () => {
		const out = renderDeploymentJsonLiveParity(repoJson, liveBody("9.4.3", 61440, 2), { tier: "warm" });
		expect(out).toContain("warm");
		expect(out).toContain("60g");
		expect(out).toContain("30g");
		expect(out).toContain("zone_count");
	});

	test("empty when in sync and when live is unreadable", () => {
		expect(
			renderDeploymentJsonLiveParity(repoJson, liveBody("9.4.3", 30720, 3), {
				tier: "warm",
				includeVersion: true,
			}),
		).toBe("");
		expect(renderDeploymentJsonLiveParity(repoJson, undefined, { tier: "warm", includeVersion: true })).toBe("");
		expect(renderDeploymentJsonLiveParity(repoJson, "[404] nope", { tier: "warm" })).toBe("");
	});

	test("never contains the reviewPlan HIGH-risk phrase 'not in live'", () => {
		const out = renderDeploymentJsonLiveParity(repoJson, liveBody("9.4.1", 61440, 1), {
			tier: "warm",
			includeVersion: true,
		});
		expect(out.length).toBeGreaterThan(0);
		expect(out).not.toContain("not in live");
	});
});

import { repoOnlyCaveat } from "./nodes.ts";

// SIO-1196 Tier 2: every no-op verdict computed from the GitOps repo file alone must say so.
describe("repoOnlyCaveat (SIO-1196)", () => {
	test("names the repo-only scope and the drift-check follow-up for the cluster", () => {
		const caveat = repoOnlyCaveat("eu-b2b");
		expect(caveat).toContain("REPO file only");
		expect(caveat).toContain('"check eu-b2b for drift"');
		expect(caveat.startsWith(" ")).toBe(true);
	});
});

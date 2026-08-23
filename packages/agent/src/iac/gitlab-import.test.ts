// agent/src/iac/gitlab-import.test.ts
// SIO-1525: the external-change importer. Pure classifiers are tested directly; the sweep is
// exercised with a routed globalThis.fetch stub + mocked memory-backend / memory-writer /
// knowledge-graph so no GitLab, REST, or lbug is touched.
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import * as realKnowledgeGraphNs from "@devops-agent/knowledge-graph";
import * as realMemoryBackendNs from "../memory-backend.ts";
import * as realMemoryWriterNs from "../memory-writer.ts";
import {
	buildImportedAnnotations,
	buildImportedDecision,
	changedJsonKeyPaths,
	classifyDeploymentsChange,
	classifyRepoPath,
	externalChangeId,
	importEnabled,
	importExternalChanges,
	importLookbackDays,
	resetImportStateForTests,
} from "./gitlab-import.ts";
// Test-only import of nodes.ts (the module under test must stay a leaf; the test may not).
import { stackForWorkflow } from "./nodes.ts";
import type { IacWorkflow } from "./state.ts";

// SIO-1045: value snapshots (spread at load time) -- a namespace import is a live view that a
// later mock.module() call would poison, making the afterAll restore a circular no-op.
const realMemoryBackend = { ...realMemoryBackendNs };
const realMemoryWriter = { ...realMemoryWriterNs };
const realKnowledgeGraph = { ...realKnowledgeGraphNs };

type FetchRoute = (url: string) => Response | null;

let backend: string = "agent-memory";
let kgEnabled = true;
let kgStoreFails = false;
let kgWriteFails = false;
let recordNowSucceeds = true;
let searchHits: Array<{ text: string; annotations: Record<string, string> }> = [];
let renovateHits: Array<{ text: string; annotations: Record<string, string> }> = [];
let recordedNowFacts: Array<{ text: string; annotations: Record<string, string> }> = [];
let dailyLogs: Array<{ summary?: string }> = [];
let kgChanges: Array<Record<string, unknown>> = [];
let kgExistingIds: Set<string> = new Set();
let kgMrUrls: Set<string> = new Set();
let fetchedUrls: string[] = [];
let routes: FetchRoute[] = [];

const realFetch = globalThis.fetch;
const priorToken = process.env.ELASTIC_IAC_GITLAB_TOKEN;

const fakeStore = {
	init: async () => {},
	run: async () => [],
	close: async () => {},
};

beforeAll(() => {
	mock.module("../memory-backend.ts", () => ({
		...realMemoryBackend,
		selectedBackend: () => backend,
		searchAgentMemory: async (_agent: string, _query: string, filter?: Record<string, string>) =>
			filter?.kind === "renovate-trigger" ? renovateHits : searchHits,
		recordAgentFactNow: async (_agent: string, text: string, annotations: Record<string, string>) => {
			recordedNowFacts.push({ text, annotations });
			return recordNowSucceeds;
		},
	}));
	mock.module("../memory-writer.ts", () => ({
		...realMemoryWriter,
		appendDailyLog: (e: { summary?: string }) => dailyLogs.push(e),
	}));
	mock.module("@devops-agent/knowledge-graph", () => ({
		...realKnowledgeGraph,
		isKnowledgeGraphEnabled: () => kgEnabled,
		getGraphStore: async () => {
			if (kgStoreFails) throw new Error("lock contention");
			return fakeStore;
		},
		recordIacChange: async (_store: unknown, change: Record<string, unknown>) => {
			if (kgWriteFails) throw new Error("kg write refused");
			kgChanges.push(change);
		},
		configChangeExists: async (_store: unknown, id: string) => kgExistingIds.has(id),
		mrUrlHasChange: async (_store: unknown, url: string) => kgMrUrls.has(url),
	}));

	process.env.ELASTIC_IAC_GITLAB_TOKEN = "test-token";
	globalThis.fetch = (async (input: string | URL | Request) => {
		const url = String(input);
		fetchedUrls.push(url);
		for (const route of routes) {
			const res = route(url);
			if (res) return res;
		}
		return new Response("not found", { status: 404, statusText: "Not Found" });
	}) as typeof fetch;
});

afterAll(() => {
	mock.module("../memory-backend.ts", () => realMemoryBackend);
	mock.module("../memory-writer.ts", () => realMemoryWriter);
	mock.module("@devops-agent/knowledge-graph", () => realKnowledgeGraph);
	globalThis.fetch = realFetch;
	if (priorToken === undefined) delete process.env.ELASTIC_IAC_GITLAB_TOKEN;
	else process.env.ELASTIC_IAC_GITLAB_TOKEN = priorToken;
});

beforeEach(() => {
	resetImportStateForTests();
	backend = "agent-memory";
	kgEnabled = true;
	kgStoreFails = false;
	kgWriteFails = false;
	recordNowSucceeds = true;
	searchHits = [];
	renovateHits = [];
	recordedNowFacts = [];
	dailyLogs = [];
	kgChanges = [];
	kgExistingIds = new Set();
	kgMrUrls = new Set();
	fetchedUrls = [];
	routes = [];
	process.env.ELASTIC_IAC_GITLAB_TOKEN = "test-token";
	delete process.env.IAC_IMPORT_LOOKBACK_DAYS;
});

function json(body: unknown): Response {
	return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

interface CommitFixture {
	id: string;
	parent_ids: string[];
	title: string;
	committed_date: string;
}

interface DiffFixture {
	old_path: string;
	new_path: string;
	new_file?: boolean;
	deleted_file?: boolean;
	renamed_file?: boolean;
}

function diffEntry(f: DiffFixture): Record<string, unknown> {
	return {
		old_path: f.old_path,
		new_path: f.new_path,
		new_file: f.new_file ?? false,
		deleted_file: f.deleted_file ?? false,
		renamed_file: f.renamed_file ?? false,
	};
}

// Route the three sweep endpoints + raw file blobs for one scenario.
function seedGitlab(opts: {
	commits: CommitFixture[];
	diffs?: Record<string, DiffFixture[]>;
	mrs?: Record<string, Array<{ iid: number; state: string; web_url: string }>>;
	raw?: Record<string, unknown>; // key `${path}@${ref}` -> parsed JSON body
	failDiffFor?: string;
}): void {
	routes.push((url) => {
		if (url.includes("/repository/commits?")) return json(opts.commits);
		const mrMatch = /repository\/commits\/([0-9a-f]+)\/merge_requests/.exec(url);
		if (mrMatch?.[1]) return json(opts.mrs?.[mrMatch[1]] ?? []);
		const diffMatch = /repository\/commits\/([0-9a-f]+)\/diff/.exec(url);
		if (diffMatch?.[1]) {
			if (opts.failDiffFor === diffMatch[1]) return new Response("boom", { status: 500, statusText: "ISE" });
			return json((opts.diffs?.[diffMatch[1]] ?? []).map(diffEntry));
		}
		const rawMatch = /repository\/files\/([^/]+)\/raw\?ref=([^&]+)/.exec(url);
		if (rawMatch?.[1] && rawMatch[2]) {
			const key = `${decodeURIComponent(rawMatch[1])}@${decodeURIComponent(rawMatch[2])}`;
			const body = opts.raw?.[key];
			if (body === undefined) return new Response("not found", { status: 404, statusText: "Not Found" });
			return new Response(JSON.stringify(body), { status: 200 });
		}
		return null;
	});
}

const SHA_A = "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2";
const SHA_B = "b1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2";
const PARENT = "0000000000000000000000000000000000000001";

function versionUpgradeScenario(overrides?: {
	mrs?: Record<string, Array<{ iid: number; state: string; web_url: string }>>;
}): void {
	seedGitlab({
		commits: [
			{ id: SHA_A, parent_ids: [PARENT], title: "bump eu-b2b to 9.5.2", committed_date: "2026-08-20T10:00:00.000Z" },
		],
		diffs: {
			[SHA_A]: [
				{ old_path: "environments/_deployments/eu-b2b.json", new_path: "environments/_deployments/eu-b2b.json" },
			],
		},
		mrs: overrides?.mrs ?? {},
		raw: {
			[`environments/_deployments/eu-b2b.json@${PARENT}`]: { version: "9.4.2", elasticsearch: { hot: { size: "8g" } } },
			[`environments/_deployments/eu-b2b.json@${SHA_A}`]: { version: "9.5.2", elasticsearch: { hot: { size: "8g" } } },
		},
	});
}

describe("classifyRepoPath (SIO-1525 scope filter)", () => {
	const inScope: Array<[string, { deleted?: boolean; newFile?: boolean }, string, IacWorkflow | "deployments-json"]> = [
		["environments/_deployments/eu-b2b.json", {}, "deployments", "deployments-json"],
		["environments/eu-b2b/lifecycle-policies/logs.json", {}, "lifecycle-policies", "ilm-rollout"],
		["environments/eu-b2b/lifecycle-policies/logs.json", { deleted: true }, "lifecycle-policies", "ilm-delete"],
		["environments/eu-b2b/fleet-integrations/integrations.json", {}, "fleet-integrations", "fleet-integration"],
		["environments/eu-b2b/slos/latency.json", {}, "slos", "slo-edit"],
		["environments/eu-b2b/alerting/cpu.json", {}, "alerting", "alerting-edit"],
		["environments/eu-b2b/dataviews/logs.json", {}, "dataviews", "dataview-edit"],
		["environments/eu-b2b/cluster-defaults/base.json", {}, "cluster-defaults", "cluster-default-edit"],
		["environments/eu-b2b/cluster-defaults/base.json", { deleted: true }, "cluster-defaults", "cluster-default-delete"],
		["environments/eu-b2b/cluster-settings/settings.json", {}, "cluster-settings", "cluster-settings-edit"],
		["environments/eu-b2b/spaces/b2b.json", {}, "spaces", "space-edit"],
		["environments/eu-b2b/security/security.json", {}, "security", "security-edit"],
		["environments/eu-b2b/dashboards/b2b__overview.ndjson", {}, "dashboards", "dashboard-edit"],
		["environments/eu-b2b/index-templates/logs.json", {}, "index-templates", "index-template-create"],
		[
			"environments/eu-b2b/ingest-pipelines/parse.json",
			{ newFile: true },
			"ingest-pipelines",
			"ingest-pipeline-create",
		],
		["environments/eu-b2b/ingest-pipelines/parse.json", {}, "ingest-pipelines", "ingest-pipeline-edit"],
	];
	test.each(inScope)("%s -> %s/%s", (path, flags, stack, workflow) => {
		const got = classifyRepoPath({ path, deleted: flags.deleted ?? false, newFile: flags.newFile ?? false });
		expect(got).not.toBeNull();
		expect(got?.deployment).toBe("eu-b2b");
		expect(got?.stack).toBe(stack);
		expect(got?.workflow).toBe(workflow);
	});

	const outOfScope: string[] = [
		"modules/deployment/main.tf",
		"stacks/deployments/main.tf",
		"environments/_shared/defaults.json",
		"environments/_deployments/traffic-filters.json",
		"environments/_deployments/versions.json",
		"environments/eu-b2b/agent-policies/policy.json", // stack the agent has no workflow for
		"environments/eu-b2b/slos/notes.md",
		"environments/eu-b2b/dashboards/overview.json", // dashboards are ndjson only
		"README.md",
		"versions.json",
	];
	test.each(outOfScope)("out of scope: %s", (path) => {
		expect(classifyRepoPath({ path, deleted: false, newFile: false })).toBeNull();
	});

	test("a deleted _deployments cluster file is out of scope (the agent cannot decommission)", () => {
		expect(
			classifyRepoPath({ path: "environments/_deployments/eu-b2b.json", deleted: true, newFile: false }),
		).toBeNull();
	});

	test("every classified stack matches nodes.ts's stackForWorkflow (enum sync)", () => {
		for (const [path, flags, stack, workflow] of inScope) {
			if (workflow === "deployments-json") {
				// The sentinel resolves to version-upgrade / tier-resize / topology-edit, all "deployments".
				for (const resolved of ["version-upgrade", "tier-resize", "topology-edit"]) {
					expect(stackForWorkflow(resolved)).toBe(stack);
				}
				continue;
			}
			const got = classifyRepoPath({ path, deleted: flags.deleted ?? false, newFile: flags.newFile ?? false });
			expect(got?.stack).toBe(stackForWorkflow(workflow));
		}
	});
});

describe("classifyDeploymentsChange", () => {
	const before = { version: "9.4.2", elasticsearch: { hot: { size: "8g", max_size: "8g" }, autoscale: false } };

	test("version change wins and captures the new version", () => {
		const after = { ...before, version: "9.5.2" };
		expect(classifyDeploymentsChange(before, after)).toEqual({ workflow: "version-upgrade", version: "9.5.2" });
	});

	test("mixed version + size still classifies as version-upgrade (precedence)", () => {
		const after = { version: "9.5.2", elasticsearch: { hot: { size: "16g", max_size: "16g" }, autoscale: false } };
		expect(classifyDeploymentsChange(before, after).workflow).toBe("version-upgrade");
	});

	test("size/max_size-only change is tier-resize", () => {
		const after = { version: "9.4.2", elasticsearch: { hot: { size: "16g", max_size: "16g" }, autoscale: false } };
		expect(classifyDeploymentsChange(before, after)).toEqual({ workflow: "tier-resize" });
	});

	test("zone_count / autoscale / user_settings_yaml edits are topology-edit", () => {
		const after = { version: "9.4.2", elasticsearch: { hot: { size: "8g", max_size: "8g" }, autoscale: true } };
		expect(classifyDeploymentsChange(before, after)).toEqual({ workflow: "topology-edit" });
	});

	test("new cluster file (no before) and unparseable JSON fall back to topology-edit", () => {
		expect(classifyDeploymentsChange(null, before)).toEqual({ workflow: "topology-edit" });
		expect(classifyDeploymentsChange(before, null)).toEqual({ workflow: "topology-edit" });
	});

	test("changedJsonKeyPaths reports dotted paths recursively", () => {
		const after = { version: "9.4.2", elasticsearch: { hot: { size: "16g", max_size: "8g" }, autoscale: false } };
		expect(changedJsonKeyPaths(before, after)).toEqual(["elasticsearch.hot.size"]);
	});
});

describe("record building", () => {
	const record = {
		id: externalChangeId(SHA_A, "eu-b2b", "version-upgrade"),
		deployment: "eu-b2b",
		stack: "deployments",
		workflow: "version-upgrade",
		filePaths: ["environments/_deployments/eu-b2b.json"],
		version: "9.5.2",
		commit: {
			id: SHA_A,
			parent_ids: [PARENT],
			title: "bump by ops@example.com",
			committed_date: "2026-08-20T10:00:00.000Z",
		},
		mrUrl: "https://gitlab.com/x/-/merge_requests/9",
		mrIid: 9,
	};

	test("externalChangeId is stable and short-sha keyed", () => {
		expect(record.id).toBe(`gitlab:${SHA_A.slice(0, 12)}:eu-b2b:version-upgrade`);
	});

	test("annotations carry the iac-change join keys + terminal lifecycle + provenance", () => {
		const a = buildImportedAnnotations(record);
		expect(a).toMatchObject({
			kind: "iac-change",
			outcome: "applied",
			lifecycle: "applied",
			external_import: "true",
			commit_sha: SHA_A,
			config_change_id: record.id,
			deployment: "eu-b2b",
			stack: "deployments",
			stack_instance: "eu-b2b/deployments",
			workflow: "version-upgrade",
			version: "9.5.2",
			mr_url: record.mrUrl,
			mr_iid: "9",
		});
		// PII in the commit title is redacted before it becomes the change_summary annotation.
		expect(a.change_summary).not.toContain("ops@example.com");
	});

	test("decision prose is redacted and states applied + external provenance", () => {
		const decision = buildImportedDecision(record);
		expect(decision).toContain("APPLIED (made outside this agent)");
		expect(decision).toContain("eu-b2b/deployments");
		expect(decision).toContain("9.5.2");
		expect(decision).not.toContain("ops@example.com");
	});
});

describe("importEnabled / importLookbackDays", () => {
	test("false without the GitLab token", () => {
		delete process.env.ELASTIC_IAC_GITLAB_TOKEN;
		expect(importEnabled()).toBe(false);
	});

	test("true when a durable store and the token are present", () => {
		backend = "file";
		kgEnabled = true;
		expect(importEnabled()).toBe(true);
		kgEnabled = false;
		expect(importEnabled()).toBe(false);
		backend = "agent-memory";
		expect(importEnabled()).toBe(true);
	});

	test("lookback default 30, defensive parse", () => {
		expect(importLookbackDays()).toBe(30);
		process.env.IAC_IMPORT_LOOKBACK_DAYS = "90";
		expect(importLookbackDays()).toBe(90);
		process.env.IAC_IMPORT_LOOKBACK_DAYS = "banana";
		expect(importLookbackDays()).toBe(30);
	});
});

describe("importExternalChanges sweep", () => {
	test("direct push with a version bump imports into BOTH stores with historical createdAt", async () => {
		versionUpgradeScenario();
		const summary = await importExternalChanges({ source: "cron", limit: 10 });
		expect(summary.imported).toBe(1);
		expect(summary.errors).toBe(0);
		expect(kgChanges).toHaveLength(1);
		expect(kgChanges[0]).toMatchObject({
			id: `gitlab:${SHA_A.slice(0, 12)}:eu-b2b:version-upgrade`,
			deployment: "eu-b2b",
			workflow: "version-upgrade",
			stackInstanceId: "eu-b2b/deployments",
			createdAt: "2026-08-20T10:00:00.000Z",
			outcome: "applied",
		});
		expect(recordedNowFacts).toHaveLength(1);
		expect(recordedNowFacts[0]?.annotations).toMatchObject({
			external_import: "true",
			lifecycle: "applied",
			version: "9.5.2",
			workflow: "version-upgrade",
		});
		// Direct push -> no mr_url annotation.
		expect(recordedNowFacts[0]?.annotations.mr_url).toBeUndefined();
		expect(dailyLogs).toHaveLength(1);
	});

	test("a commit whose MR this agent already recorded is skipped (memory mr_url set)", async () => {
		const mrUrl = "https://gitlab.com/x/-/merge_requests/42";
		versionUpgradeScenario({ mrs: { [SHA_A]: [{ iid: 42, state: "merged", web_url: mrUrl }] } });
		searchHits = [{ text: "prior proposal", annotations: { kind: "iac-change", mr_url: mrUrl } }];
		const summary = await importExternalChanges({ source: "cron", limit: 10 });
		expect(summary.skippedAlreadyRecorded).toBe(1);
		expect(summary.imported).toBe(0);
		expect(kgChanges).toHaveLength(0);
		expect(recordedNowFacts).toHaveLength(0);
	});

	test("a commit whose MR this agent recorded as a renovate-trigger fact is skipped", async () => {
		const mrUrl = "https://gitlab.com/x/-/merge_requests/77";
		versionUpgradeScenario({ mrs: { [SHA_A]: [{ iid: 77, state: "merged", web_url: mrUrl }] } });
		renovateHits = [{ text: "renovate mr", annotations: { kind: "renovate-trigger", mr_url: mrUrl } }];
		const summary = await importExternalChanges({ source: "cron", limit: 10 });
		expect(summary.skippedAlreadyRecorded).toBe(1);
		expect(summary.imported).toBe(0);
	});

	test("a commit whose MR has a KG PROPOSED_IN edge is skipped", async () => {
		const mrUrl = "https://gitlab.com/x/-/merge_requests/43";
		versionUpgradeScenario({ mrs: { [SHA_A]: [{ iid: 43, state: "merged", web_url: mrUrl }] } });
		kgMrUrls = new Set([mrUrl]);
		const summary = await importExternalChanges({ source: "cron", limit: 10 });
		expect(summary.skippedAlreadyRecorded).toBe(1);
		expect(summary.imported).toBe(0);
	});

	test("an unrecorded MR (e.g. another agent's, labels irrelevant) IS imported with mr_url", async () => {
		const mrUrl = "https://gitlab.com/x/-/merge_requests/44";
		versionUpgradeScenario({ mrs: { [SHA_A]: [{ iid: 44, state: "merged", web_url: mrUrl }] } });
		const summary = await importExternalChanges({ source: "cron", limit: 10 });
		expect(summary.imported).toBe(1);
		expect(recordedNowFacts[0]?.annotations).toMatchObject({ mr_url: mrUrl, mr_iid: "44" });
		expect(kgChanges[0]).toMatchObject({ mrUrl });
	});

	test("out-of-scope and empty diffs count as skippedOutOfScope", async () => {
		seedGitlab({
			commits: [
				{ id: SHA_A, parent_ids: [PARENT], title: "docs", committed_date: "2026-08-20T10:00:00.000Z" },
				{ id: SHA_B, parent_ids: [SHA_A], title: "empty merge", committed_date: "2026-08-20T11:00:00.000Z" },
			],
			diffs: { [SHA_A]: [{ old_path: "README.md", new_path: "README.md" }], [SHA_B]: [] },
		});
		const summary = await importExternalChanges({ source: "cron", limit: 10 });
		expect(summary.skippedOutOfScope).toBe(2);
		expect(summary.imported).toBe(0);
	});

	test("re-sweep of an already-imported window reports alreadyImported and writes nothing", async () => {
		versionUpgradeScenario();
		const id = externalChangeId(SHA_A, "eu-b2b", "version-upgrade");
		kgExistingIds = new Set([id]);
		searchHits = [
			{ text: "imported", annotations: { kind: "iac-change", external_import: "true", config_change_id: id } },
		];
		const summary = await importExternalChanges({ source: "cron", limit: 10 });
		expect(summary.alreadyImported).toBe(1);
		expect(summary.imported).toBe(0);
		expect(kgChanges).toHaveLength(0);
		expect(recordedNowFacts).toHaveLength(0);
	});

	test("partial state retries only the missing store: KG has it, memory does not", async () => {
		versionUpgradeScenario();
		kgExistingIds = new Set([externalChangeId(SHA_A, "eu-b2b", "version-upgrade")]);
		const summary = await importExternalChanges({ source: "cron", limit: 10 });
		expect(summary.imported).toBe(1); // the memory leg newly accepted it
		expect(kgChanges).toHaveLength(0); // the KG leg was not re-written
		expect(recordedNowFacts).toHaveLength(1);
	});

	test("one commit's failure increments errors without aborting the sweep", async () => {
		seedGitlab({
			commits: [
				{ id: SHA_A, parent_ids: [PARENT], title: "broken", committed_date: "2026-08-20T10:00:00.000Z" },
				{ id: SHA_B, parent_ids: [SHA_A], title: "bump eu-b2b", committed_date: "2026-08-20T11:00:00.000Z" },
			],
			failDiffFor: SHA_A,
			diffs: {
				[SHA_B]: [
					{ old_path: "environments/_deployments/eu-b2b.json", new_path: "environments/_deployments/eu-b2b.json" },
				],
			},
			raw: {
				[`environments/_deployments/eu-b2b.json@${SHA_A}`]: { version: "9.4.2" },
				[`environments/_deployments/eu-b2b.json@${SHA_B}`]: { version: "9.5.2" },
			},
		});
		const summary = await importExternalChanges({ source: "cron", limit: 10 });
		expect(summary.errors).toBe(1);
		expect(summary.imported).toBe(1);
	});

	test("a partially-imported MR commit is NOT commit-skipped: the import's own fact/edge is excluded from the mr_url skip", async () => {
		const mrUrl = "https://gitlab.com/x/-/merge_requests/88";
		const id = externalChangeId(SHA_A, "eu-b2b", "version-upgrade");
		versionUpgradeScenario({ mrs: { [SHA_A]: [{ iid: 88, state: "merged", web_url: mrUrl }] } });
		// First sweep wrote the KG record (with its PROPOSED_IN edge) but the memory write failed.
		// The real mrUrlHasChange ignores gitlab:-prefixed changes, so the mock's set stays empty;
		// only the per-record kg id exists. The import's own fact (if any) carries external_import
		// and must feed importedIds, never the commit-level skip.
		kgExistingIds = new Set([id]);
		searchHits = [
			{
				text: "imported",
				annotations: {
					kind: "iac-change",
					external_import: "true",
					config_change_id: "gitlab:other:x:y",
					mr_url: mrUrl,
				},
			},
		];
		const summary = await importExternalChanges({ source: "cron", limit: 10 });
		expect(summary.skippedAlreadyRecorded).toBe(0);
		expect(summary.imported).toBe(1); // memory leg retried and accepted
		expect(recordedNowFacts).toHaveLength(1);
		expect(kgChanges).toHaveLength(0); // KG leg deduped, not re-written
	});

	test("a KG write failure with a memory success is PARTIAL: counted as an error, watermark frozen", async () => {
		kgWriteFails = true;
		versionUpgradeScenario();
		const first = await importExternalChanges({ source: "cron", limit: 10 });
		expect(first.errors).toBe(1);
		expect(first.imported).toBe(0);
		expect(recordedNowFacts).toHaveLength(1); // the memory leg DID accept it

		// Frozen watermark re-lists the commit; the memory store dedupes, the KG leg retries clean.
		kgWriteFails = false;
		searchHits = recordedNowFacts.map((f) => ({ text: f.text, annotations: f.annotations }));
		const second = await importExternalChanges({ source: "cron", limit: 10 });
		expect(second.imported).toBe(1); // KG leg newly accepted
		expect(kgChanges).toHaveLength(1);
		expect(recordedNowFacts).toHaveLength(1); // no duplicate memory fact
	});

	test("KG enabled but store unavailable aborts the sweep instead of importing memory-only", async () => {
		kgStoreFails = true;
		versionUpgradeScenario();
		const summary = await importExternalChanges({ source: "cron", limit: 10 });
		expect(summary.errors).toBe(1);
		expect(summary.imported).toBe(0);
		expect(recordedNowFacts).toHaveLength(0);
	});

	test("mixed committed_date UTC offsets order by epoch, not lexicographically", async () => {
		// SHA_A is OLDER by epoch (11:30+02:00 = 09:30Z) but lexicographically larger than
		// SHA_B (10:00Z). With limit 1 the epoch-older, out-of-scope SHA_A must be processed.
		seedGitlab({
			commits: [
				{ id: SHA_B, parent_ids: [SHA_A], title: "newer utc", committed_date: "2026-08-20T10:00:00.000Z" },
				{ id: SHA_A, parent_ids: [PARENT], title: "older cet", committed_date: "2026-08-20T11:30:00.000+02:00" },
			],
			diffs: {
				[SHA_A]: [{ old_path: "README.md", new_path: "README.md" }],
				[SHA_B]: [
					{ old_path: "environments/_deployments/eu-b2b.json", new_path: "environments/_deployments/eu-b2b.json" },
				],
			},
			raw: {
				[`environments/_deployments/eu-b2b.json@${SHA_A}`]: { version: "9.4.2" },
				[`environments/_deployments/eu-b2b.json@${SHA_B}`]: { version: "9.5.2" },
			},
		});
		const summary = await importExternalChanges({ source: "cron", limit: 1 });
		expect(summary.skippedOutOfScope).toBe(1);
		expect(summary.imported).toBe(0);
	});

	test("a failed memory write is an error and the next sweep re-lists from the frozen watermark", async () => {
		kgEnabled = false;
		recordNowSucceeds = false;
		versionUpgradeScenario();
		const first = await importExternalChanges({ source: "cron", limit: 10 });
		expect(first.errors).toBe(1);
		expect(first.imported).toBe(0);

		// The failed commit froze the watermark, so the second sweep still lists a window
		// containing it (the since param stays lookback-based, not advanced past the commit).
		fetchedUrls = [];
		recordNowSucceeds = true;
		const second = await importExternalChanges({ source: "cron", limit: 10 });
		expect(second.imported).toBe(1);
		const listUrl = fetchedUrls.find((u) => u.includes("/repository/commits?"));
		expect(listUrl).toBeDefined();
	});

	test("a clean sweep advances the watermark used by the next sweep's since param", async () => {
		versionUpgradeScenario();
		await importExternalChanges({ source: "cron", limit: 10 });
		fetchedUrls = [];
		await importExternalChanges({ source: "cron", limit: 10 });
		const listUrl = fetchedUrls.find((u) => u.includes("/repository/commits?")) ?? "";
		const since = decodeURIComponent(/since=([^&]+)/.exec(listUrl)?.[1] ?? "");
		// watermark (2026-08-20T10:00Z) minus the 15-minute overlap.
		expect(since).toBe("2026-08-20T09:45:00.000Z");
	});

	test("disabled (no token) returns an empty summary without fetching", async () => {
		delete process.env.ELASTIC_IAC_GITLAB_TOKEN;
		const summary = await importExternalChanges({ source: "cron", limit: 10 });
		expect(summary.commitsListed).toBe(0);
		expect(fetchedUrls).toHaveLength(0);
	});

	test("commit cap keeps the OLDEST commits and marks the summary truncated", async () => {
		// GitLab lists newest-first; seed in API order. The cap must drop the NEWEST commit (it
		// stays above the watermark for the next sweep), never the oldest (stranded forever).
		seedGitlab({
			commits: [
				{ id: SHA_B, parent_ids: [SHA_A], title: "newest in scope", committed_date: "2026-08-20T11:00:00.000Z" },
				{ id: SHA_A, parent_ids: [PARENT], title: "oldest docs", committed_date: "2026-08-20T10:00:00.000Z" },
			],
			diffs: {
				[SHA_A]: [{ old_path: "README.md", new_path: "README.md" }],
				[SHA_B]: [
					{ old_path: "environments/_deployments/eu-b2b.json", new_path: "environments/_deployments/eu-b2b.json" },
				],
			},
			raw: {
				[`environments/_deployments/eu-b2b.json@${SHA_A}`]: { version: "9.4.2" },
				[`environments/_deployments/eu-b2b.json@${SHA_B}`]: { version: "9.5.2" },
			},
		});
		const summary = await importExternalChanges({ source: "cron", limit: 1 });
		expect(summary.truncated).toBe(true);
		expect(summary.commitsListed).toBe(1);
		// The oldest (out-of-scope) commit was the one processed; the in-scope newest waits.
		expect(summary.skippedOutOfScope).toBe(1);
		expect(summary.imported).toBe(0);
	});
});

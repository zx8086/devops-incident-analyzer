// agent/src/iac/cluster-default-delete.test.ts
import { describe, expect, mock, test } from "bun:test";
import { branchSlug, parseIntentJson } from "./nodes.ts";
import type { IacPlanReport, IacRequest, IacStateType } from "./state.ts";

const asIacState = (partial: Partial<IacStateType>): IacStateType => partial as unknown as IacStateType;

const QUERYLOG = "logs-elasticsearch.querylog@settings";
const QUERYLOG_PATH = `environments/eu-b2b/cluster-defaults/${QUERYLOG}.json`;

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

describe("parseIntentJson — cluster-default-delete", () => {
	test("extracts clusterDefaultDeletes[] with verbatim basenames", () => {
		const raw = JSON.stringify({
			workflow: "cluster-default-delete",
			cluster: "eu-b2b",
			clusterDefaultDeletes: [{ templateName: QUERYLOG }],
		});
		const req = parseIntentJson(raw);
		expect(req.workflow).toBe("cluster-default-delete");
		expect(req.cluster).toBe("eu-b2b");
		expect(req.clusterDefaultDeletes).toHaveLength(1);
		// The @settings suffix is part of the basename and is preserved.
		expect(req.clusterDefaultDeletes?.[0]?.templateName).toBe(QUERYLOG);
		expect(req.clarification).toBeUndefined();
	});

	test("strips a trailing .json from the basename (keeps the @settings suffix)", () => {
		const raw = JSON.stringify({
			workflow: "cluster-default-delete",
			cluster: "eu-b2b",
			clusterDefaultDeletes: [{ templateName: `${QUERYLOG}.json` }],
		});
		const req = parseIntentJson(raw);
		expect(req.clusterDefaultDeletes?.[0]?.templateName).toBe(QUERYLOG);
	});
});

describe("branchSlug — cluster-default-delete", () => {
	test("uses cluster + revert-<names> + workflow (40-char cap)", () => {
		const req: IacRequest = {
			workflow: "cluster-default-delete",
			isProd: false,
			cluster: "eu-b2b",
			clusterDefaultDeletes: [{ templateName: QUERYLOG }],
		};
		const slug = branchSlug(req);
		expect(slug.length).toBeLessThanOrEqual(40);
		expect(slug.startsWith("eu-b2b-revert-")).toBe(true);
	});
});

describe("draftChange -> proposeClusterDefaultDelete", () => {
	test("happy path: stages a delete (no content) on ONE branch, sets diff + proposedFiles", async () => {
		const { draftChange } = await import("./nodes.ts");
		const committed: Array<Record<string, unknown>> = [];
		let branchCreates = 0;
		const existing = `[200] ${JSON.stringify({
			content: Buffer.from('{\n  "template": {\n    "settings": {}\n  }\n}\n').toString("base64"),
			encoding: "base64",
		})}`;
		mockTools({
			gitlab_get_file_content: () => existing,
			gitlab_create_branch: () => {
				branchCreates += 1;
				return "[201] {}";
			},
			gitlab_commit_files: (args) => {
				committed.push(args);
				return "[201] {}";
			},
		});
		const state = {
			iacRequest: {
				workflow: "cluster-default-delete" as const,
				isProd: false,
				cluster: "eu-b2b",
				clusterDefaultDeletes: [{ templateName: QUERYLOG }],
			},
		};
		const result = await draftChange(asIacState(state));
		expect(result.precheckPassed).toBe(true);
		expect(branchCreates).toBe(1);
		expect(committed).toHaveLength(1);
		const files = committed[0]?.files as Array<Record<string, unknown>>;
		expect(files).toHaveLength(1);
		expect(files[0]?.action).toBe("delete");
		expect(files[0]?.file_path).toBe(QUERYLOG_PATH);
		// A delete carries no content from the proposer.
		expect(files[0]?.content).toBeUndefined();
		expect(result.proposedFiles).toEqual([QUERYLOG_PATH]);
		expect(result.proposedDiff).toContain("remove override file");
	});

	test("no-op: every target already absent -> noopReason, no commit, no MR", async () => {
		const { draftChange } = await import("./nodes.ts");
		let commits = 0;
		mockTools({
			gitlab_get_file_content: () => '[404] {"message":"404 File Not Found"}',
			gitlab_create_branch: () => "[201] {}",
			gitlab_commit_files: () => {
				commits += 1;
				return "[201] {}";
			},
		});
		const state = {
			iacRequest: {
				workflow: "cluster-default-delete" as const,
				isProd: false,
				cluster: "eu-b2b",
				clusterDefaultDeletes: [{ templateName: QUERYLOG }],
			},
		};
		const result = await draftChange(asIacState(state));
		expect(result.noopReason).toContain("already absent");
		expect(String(result.messages?.[0]?.content ?? "")).toContain("REPO file only"); // SIO-1196
		expect(result.blockedReason).toBeFalsy();
		expect(commits).toBe(0);
	});

	test("blocks when no deployment is named", async () => {
		const { draftChange } = await import("./nodes.ts");
		mockTools({});
		const result = await draftChange(
			asIacState({
				iacRequest: {
					workflow: "cluster-default-delete" as const,
					isProd: false,
					clusterDefaultDeletes: [{ templateName: QUERYLOG }],
				},
			}),
		);
		expect(result.blockedReason).toContain("deployment");
	});

	test("blocks when no override file is named", async () => {
		const { draftChange } = await import("./nodes.ts");
		mockTools({});
		const result = await draftChange(
			asIacState({
				iacRequest: {
					workflow: "cluster-default-delete" as const,
					isProd: false,
					cluster: "eu-b2b",
					clusterDefaultDeletes: [],
				},
			}),
		);
		expect(result.blockedReason).toContain("at least one");
	});

	test("blocks (atomic) when a target read fails with a non-404 error", async () => {
		const { draftChange } = await import("./nodes.ts");
		let commits = 0;
		mockTools({
			gitlab_get_file_content: () => '[500] {"message":"server error"}',
			gitlab_create_branch: () => "[201] {}",
			gitlab_commit_files: () => {
				commits += 1;
				return "[201] {}";
			},
		});
		const result = await draftChange(
			asIacState({
				iacRequest: {
					workflow: "cluster-default-delete" as const,
					isProd: false,
					cluster: "eu-b2b",
					clusterDefaultDeletes: [{ templateName: QUERYLOG }],
				},
			}),
		);
		expect(result.blockedReason).toContain("Could not read");
		expect(commits).toBe(0);
	});
});

describe("teardownIac — cluster-default-delete §7 verdict (SIO-1022)", () => {
	const planReport = (create: number, update: number, del: number): IacPlanReport => ({
		create,
		update,
		delete: del,
		resources: [],
	});

	const baseState = (planReportValue: IacPlanReport | undefined, mrState?: string): Partial<IacStateType> => ({
		intent: "gitops",
		mrUrl: "https://gitlab.com/x/-/merge_requests/9",
		mrState: mrState as IacStateType["mrState"],
		pipelineStatus: "success",
		planReport: planReportValue,
		iacRequest: {
			workflow: "cluster-default-delete" as const,
			isProd: false,
			cluster: "eu-b2b",
			clusterDefaultDeletes: [{ templateName: QUERYLOG }],
		},
	});

	async function teardownMessage(state: Partial<IacStateType>): Promise<string> {
		mockTools({}); // recallIacChangeIntent etc. fall back to empty without a backend
		const { teardownIac } = await import("./nodes.ts");
		const result = await teardownIac(asIacState(state));
		const msg = result.messages?.[result.messages.length - 1];
		return String((msg as { content?: unknown })?.content ?? "");
	}

	test("0/0/0 plan -> NO-OP CLEANUP verdict", async () => {
		const out = await teardownMessage(baseState(planReport(0, 0, 0)));
		expect(out).toContain("NO-OP CLEANUP");
		expect(out).toContain("0 destroy");
	});

	test("delete>0 plan -> DESTRUCTIVE verdict naming the count", async () => {
		const out = await teardownMessage(baseState(planReport(0, 0, 1)));
		expect(out).toContain("DESTRUCTIVE");
		expect(out).toContain("1 resource(s) to destroy");
	});

	test("no plan report yet (MR open) -> neutral 'verify before merge' wording", async () => {
		const out = await teardownMessage(baseState(undefined, "opened"));
		expect(out).toContain("has not reported yet");
		expect(out).toContain("verify it shows 0 destroy");
	});
});

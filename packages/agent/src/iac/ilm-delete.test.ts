// agent/src/iac/ilm-delete.test.ts
// SIO-1037: ilm-delete removes a whole ILM policy file (environments/<dep>/lifecycle-policies/<policy>.json).
// Mirrors cluster-default-delete.test.ts. The distinctive case here is a LEADING dot in the basename
// (.alerts-ilm-policy) -- the fold strips only a trailing .json, so the dot must survive.
import { describe, expect, mock, test } from "bun:test";
import { branchSlug, parseIntentJson } from "./nodes.ts";
import type { IacPlanReport, IacRequest, IacStateType } from "./state.ts";

const asIacState = (partial: Partial<IacStateType>): IacStateType => partial as unknown as IacStateType;

const ALERTS = ".alerts-ilm-policy";
const ALERTS_PATH = `environments/eu-b2b/lifecycle-policies/${ALERTS}.json`;

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

describe("parseIntentJson — ilm-delete", () => {
	test("extracts ilmDeletes[] with verbatim basenames (leading dot preserved)", () => {
		const raw = JSON.stringify({
			workflow: "ilm-delete",
			cluster: "eu-b2b",
			ilmDeletes: [{ policyName: ALERTS }],
		});
		const req = parseIntentJson(raw);
		expect(req.workflow).toBe("ilm-delete");
		expect(req.cluster).toBe("eu-b2b");
		expect(req.ilmDeletes).toHaveLength(1);
		// The leading dot is part of the basename and is preserved.
		expect(req.ilmDeletes?.[0]?.policyName).toBe(ALERTS);
		expect(req.clarification).toBeUndefined();
	});

	test("strips a trailing .json but keeps the leading dot", () => {
		const raw = JSON.stringify({
			workflow: "ilm-delete",
			cluster: "eu-b2b",
			ilmDeletes: [{ policyName: `${ALERTS}.json` }],
		});
		const req = parseIntentJson(raw);
		expect(req.ilmDeletes?.[0]?.policyName).toBe(ALERTS);
	});
});

describe("branchSlug — ilm-delete", () => {
	test("uses cluster + remove-<names> + workflow (40-char cap, dot normalized)", () => {
		const req: IacRequest = {
			workflow: "ilm-delete",
			isProd: false,
			cluster: "eu-b2b",
			ilmDeletes: [{ policyName: ALERTS }],
		};
		const slug = branchSlug(req);
		expect(slug.length).toBeLessThanOrEqual(40);
		expect(slug.startsWith("eu-b2b-remove-")).toBe(true);
		// A branch slug is [a-z0-9-] only: the leading dot is normalized away.
		expect(slug).toMatch(/^[a-z0-9-]+$/);
	});
});

describe("draftChange -> proposeIlmDelete", () => {
	test("happy path: stages a delete (no content) on ONE branch, sets diff + proposedFiles", async () => {
		const { draftChange } = await import("./nodes.ts");
		const committed: Array<Record<string, unknown>> = [];
		let branchCreates = 0;
		const existing = `[200] ${JSON.stringify({
			content: Buffer.from('{\n  "name": ".alerts-ilm-policy"\n}\n').toString("base64"),
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
				workflow: "ilm-delete" as const,
				isProd: false,
				cluster: "eu-b2b",
				ilmDeletes: [{ policyName: ALERTS }],
			},
		};
		const result = await draftChange(asIacState(state));
		expect(result.precheckPassed).toBe(true);
		expect(branchCreates).toBe(1);
		expect(committed).toHaveLength(1);
		const files = committed[0]?.files as Array<Record<string, unknown>>;
		expect(files).toHaveLength(1);
		expect(files[0]?.action).toBe("delete");
		expect(files[0]?.file_path).toBe(ALERTS_PATH);
		// A delete carries no content from the proposer.
		expect(files[0]?.content).toBeUndefined();
		expect(result.proposedFiles).toEqual([ALERTS_PATH]);
		expect(result.proposedDiff).toContain("remove ILM policy file");
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
				workflow: "ilm-delete" as const,
				isProd: false,
				cluster: "eu-b2b",
				ilmDeletes: [{ policyName: ALERTS }],
			},
		};
		const result = await draftChange(asIacState(state));
		expect(result.noopReason).toContain("already absent");
		expect(result.blockedReason).toBeFalsy();
		expect(commits).toBe(0);
	});

	test("blocks when no deployment is named", async () => {
		const { draftChange } = await import("./nodes.ts");
		mockTools({});
		const result = await draftChange(
			asIacState({
				iacRequest: {
					workflow: "ilm-delete" as const,
					isProd: false,
					ilmDeletes: [{ policyName: ALERTS }],
				},
			}),
		);
		expect(result.blockedReason).toContain("deployment");
	});

	test("blocks when no policy file is named", async () => {
		const { draftChange } = await import("./nodes.ts");
		mockTools({});
		const result = await draftChange(
			asIacState({
				iacRequest: {
					workflow: "ilm-delete" as const,
					isProd: false,
					cluster: "eu-b2b",
					ilmDeletes: [],
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
					workflow: "ilm-delete" as const,
					isProd: false,
					cluster: "eu-b2b",
					ilmDeletes: [{ policyName: ALERTS }],
				},
			}),
		);
		expect(result.blockedReason).toContain("Could not read");
		expect(commits).toBe(0);
	});
});

describe("teardownIac — ilm-delete §7 verdict (SIO-1037)", () => {
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
			workflow: "ilm-delete" as const,
			isProd: false,
			cluster: "eu-b2b",
			ilmDeletes: [{ policyName: ALERTS }],
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

// agent/src/iac/dashboard-edit.test.ts
import { describe, expect, mock, test } from "bun:test";
import { branchSlug, parseIntentJson, reviewPlan, validateNdjsonLines } from "./nodes.ts";
import type { IacRequest, IacStateType } from "./state.ts";

// draftChange/reviewPlan read only a slice of IacState in these tests; the approved test-stub
// cast (Partial<T> as unknown as T) keeps the call typed without `as any`.
const asIacState = (partial: Partial<IacStateType>): IacStateType => partial as unknown as IacStateType;

// A real-shaped (small) Kibana dashboard NDJSON export: ONE saved-object line + the trailing
// export-summary line. Mirrors the live developer-experience__amazon_bedrock_token_usage.ndjson
// shape (dashboard object with attributes.title + an export summary with exportedCount). The
// proposer must commit this VERBATIM -- never JSON.parse the whole thing as one object.
const DASHBOARD_LINE =
	'{"attributes":{"title":"Amazon Bedrock Token Usage","description":"tokens per user","panelsJSON":"[{\\"panelIndex\\":\\"p1\\",\\"type\\":\\"lens\\"}]"},"coreMigrationVersion":"8.8.0","id":"generative-ai-token-usage","managed":false,"references":[],"type":"dashboard","version":"WzIxMzYwOCw4NF0="}';
const SUMMARY_LINE =
	'{"excludedObjects":[],"excludedObjectsCount":0,"exportedCount":1,"missingRefCount":0,"missingReferences":[]}';
// Two-object export (dashboard + a lens) + summary -> a 3-line NDJSON.
const LENS_LINE = '{"attributes":{"title":"Empty XY"},"id":"lens-1","references":[],"type":"lens"}';
const NDJSON_1OBJ = `${DASHBOARD_LINE}\n${SUMMARY_LINE}`;
const NDJSON_2OBJ = `${DASHBOARD_LINE}\n${LENS_LINE}\n${SUMMARY_LINE}`;

// A spaces/<space>.json file body (only its presence/absence matters to the proposer's cross-check).
const SPACE_FILE = `[200] ${JSON.stringify({ content: Buffer.from(JSON.stringify({ id: "developer-experience", name: "Developer Experience" }, null, 2)).toString("base64"), encoding: "base64" })}`;
const NOT_FOUND = '[404] {"message":"404 File Not Found"}';

describe("validateNdjsonLines", () => {
	test("counts saved-object lines (excludes the export summary), accepts a multi-line file", () => {
		const r = validateNdjsonLines(NDJSON_2OBJ);
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.objectCount).toBe(2); // dashboard + lens; the summary line is excluded
	});

	test("single-object export counts 1", () => {
		const r = validateNdjsonLines(NDJSON_1OBJ);
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.objectCount).toBe(1);
	});

	test("ignores blank/trailing-newline lines", () => {
		const r = validateNdjsonLines(`${NDJSON_1OBJ}\n`);
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.objectCount).toBe(1);
	});

	test("rejects a malformed line and reports its 1-based number (never whole-file parse)", () => {
		const bad = `${DASHBOARD_LINE}\n{not json}\n${SUMMARY_LINE}`;
		const r = validateNdjsonLines(bad);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.badLine).toBe(2);
	});
});

describe("parseIntentJson — dashboard-edit", () => {
	test("maps space/name/ndjson/action fields", () => {
		const req = parseIntentJson(
			JSON.stringify({
				workflow: "dashboard-edit",
				cluster: "eu-b2b",
				dashboardSpace: "developer-experience",
				dashboardName: "amazon_bedrock_token_usage",
				dashboardNdjson: NDJSON_1OBJ,
				dashboardAction: "add",
			}),
		);
		expect(req?.workflow).toBe("dashboard-edit");
		expect(req?.cluster).toBe("eu-b2b");
		expect(req?.dashboardSpace).toBe("developer-experience");
		expect(req?.dashboardName).toBe("amazon_bedrock_token_usage");
		expect(req?.dashboardNdjson).toBe(NDJSON_1OBJ);
		expect(req?.dashboardAction).toBe("add");
	});
});

describe("branchSlug — dashboard", () => {
	test("includes the space (slugs repeat across spaces) + name, sliced to 40 chars", () => {
		const base: Omit<IacRequest, "dashboardSpace"> = {
			workflow: "dashboard-edit",
			isProd: false,
			cluster: "eu-b2b",
			dashboardName: "amazon_bedrock_token_usage",
			dashboardAction: "add",
		};
		const a = branchSlug({ ...base, dashboardSpace: "developer-experience" });
		const b = branchSlug({ ...base, dashboardSpace: "default" });
		// the space must distinguish two same-named dashboards in different spaces
		expect(a).not.toBe(b);
		expect(a.startsWith("eu-b2b-developer-experience-")).toBe(true);
		expect(b.startsWith("eu-b2b-default-amazon")).toBe(true);
		expect(a.length).toBeLessThanOrEqual(40);
	});
});

describe("draftChange -> proposeDashboardChange", () => {
	// The proxy returns a dashboard file as a plain UTF-8 string (not base64) -- extractFileContent
	// handles both; the mock returns the raw NDJSON for an existing file.
	const existingDashboard = `[200] ${JSON.stringify({ content: NDJSON_1OBJ })}`;

	// A space-aware mock: spaces/<space>.json resolves, the dashboard file is whatever `dash` says.
	function dashMock(dash: string, capture?: (args: Record<string, unknown>) => void) {
		mockTools({
			gitlab_get_file_content: (args) => {
				const fp = String(args.filePath ?? "");
				if (fp.includes("/spaces/")) return SPACE_FILE;
				return dash;
			},
			gitlab_create_branch: () => "[201] {}",
			gitlab_commit_file: (args) => {
				capture?.(args);
				return "[201] {}";
			},
		});
	}

	test("add happy path: commits a NEW <space>__<name>.ndjson via create, raw NDJSON verbatim", async () => {
		const { draftChange } = await import("./nodes.ts");
		let committed: Record<string, unknown> = {};
		dashMock(NOT_FOUND, (args) => {
			committed = args;
		});
		const state = {
			iacRequest: {
				workflow: "dashboard-edit" as const,
				isProd: false,
				cluster: "eu-b2b",
				dashboardSpace: "developer-experience",
				dashboardName: "amazon_bedrock_token_usage",
				dashboardNdjson: NDJSON_2OBJ,
				dashboardAction: "add" as const,
			},
		};
		const result = await draftChange(asIacState(state));
		expect(result.precheckPassed).toBe(true);
		expect(result.proposedFilePath).toBe(
			"environments/eu-b2b/dashboards/developer-experience__amazon_bedrock_token_usage.ndjson",
		);
		// create action for an add, and the body is the ORIGINAL string byte-for-byte (no re-serialize)
		expect(committed.action).toBe("create");
		expect(committed.content).toBe(NDJSON_2OBJ);
	});

	test("raw-NDJSON guarantee: committed content equals the input string byte-for-byte", async () => {
		const { draftChange } = await import("./nodes.ts");
		let committed: Record<string, unknown> = {};
		dashMock(NOT_FOUND, (args) => {
			committed = args;
		});
		const state = {
			iacRequest: {
				workflow: "dashboard-edit" as const,
				isProd: false,
				cluster: "eu-b2b",
				dashboardSpace: "developer-experience",
				dashboardName: "new_board",
				dashboardNdjson: NDJSON_2OBJ,
				dashboardAction: "add" as const,
			},
		};
		await draftChange(asIacState(state));
		// byte-for-byte identity proves there was no whole-file JSON.parse + re-stringify
		expect(committed.content).toBe(NDJSON_2OBJ);
		expect(String(committed.content).split("\n").length).toBe(3);
	});

	test("replace happy path: existing file -> update action", async () => {
		const { draftChange } = await import("./nodes.ts");
		let committed: Record<string, unknown> = {};
		dashMock(existingDashboard, (args) => {
			committed = args;
		});
		const state = {
			iacRequest: {
				workflow: "dashboard-edit" as const,
				isProd: false,
				cluster: "eu-b2b",
				dashboardSpace: "developer-experience",
				dashboardName: "amazon_bedrock_token_usage",
				dashboardNdjson: NDJSON_1OBJ,
				dashboardAction: "replace" as const,
			},
		};
		const result = await draftChange(asIacState(state));
		expect(result.precheckPassed).toBe(true);
		expect(committed.action).toBe("update");
	});

	test("diff is a SUMMARY (filename + count + bytes), never the NDJSON body", async () => {
		const { draftChange } = await import("./nodes.ts");
		dashMock(NOT_FOUND);
		const state = {
			iacRequest: {
				workflow: "dashboard-edit" as const,
				isProd: false,
				cluster: "eu-b2b",
				dashboardSpace: "developer-experience",
				dashboardName: "amazon_bedrock_token_usage",
				dashboardNdjson: NDJSON_2OBJ,
				dashboardAction: "add" as const,
			},
		};
		const result = await draftChange(asIacState(state));
		expect(result.proposedDiff).toContain("developer-experience__amazon_bedrock_token_usage.ndjson");
		expect(result.proposedDiff).toContain("2 saved objects");
		expect(result.proposedDiff).toContain("bytes");
		// the body (an inner panel id) must NOT leak into the diff
		expect(result.proposedDiff).not.toContain("generative-ai-token-usage");
		expect(result.proposedDiff).not.toContain("panelsJSON");
	});

	test("empty NDJSON blocks (no commit)", async () => {
		const { draftChange } = await import("./nodes.ts");
		mockTools({}); // no tools -> proves the guard fires before any repo read
		const state = {
			iacRequest: {
				workflow: "dashboard-edit" as const,
				isProd: false,
				cluster: "eu-b2b",
				dashboardSpace: "developer-experience",
				dashboardName: "x",
				dashboardNdjson: "   ",
				dashboardAction: "add" as const,
			},
		};
		const result = await draftChange(asIacState(state));
		expect(result.blockedReason).toContain("NDJSON");
		expect(result.precheckPassed).toBeUndefined();
	});

	test("malformed NDJSON blocks with the bad line number", async () => {
		const { draftChange } = await import("./nodes.ts");
		mockTools({}); // guard fires before repo read
		const state = {
			iacRequest: {
				workflow: "dashboard-edit" as const,
				isProd: false,
				cluster: "eu-b2b",
				dashboardSpace: "developer-experience",
				dashboardName: "x",
				dashboardNdjson: `${DASHBOARD_LINE}\n{broken}\n${SUMMARY_LINE}`,
				dashboardAction: "add" as const,
			},
		};
		const result = await draftChange(asIacState(state));
		expect(result.blockedReason).toContain("malformed");
		expect(result.blockedReason).toContain("line 2");
	});

	test("unknown space blocks (the <space>__ prefix must match an existing space)", async () => {
		const { draftChange } = await import("./nodes.ts");
		// spaces/<space>.json 404s -> space doesn't exist; dashboard read never decides the outcome
		mockTools({
			gitlab_get_file_content: (args) => (String(args.filePath ?? "").includes("/spaces/") ? NOT_FOUND : NOT_FOUND),
		});
		const state = {
			iacRequest: {
				workflow: "dashboard-edit" as const,
				isProd: false,
				cluster: "eu-b2b",
				dashboardSpace: "ghost-space",
				dashboardName: "x",
				dashboardNdjson: NDJSON_1OBJ,
				dashboardAction: "add" as const,
			},
		};
		const result = await draftChange(asIacState(state));
		expect(result.blockedReason).toContain("ghost-space");
		expect(result.blockedReason).toContain("not a space");
	});

	test("add blocks when the file already exists (no silent clobber)", async () => {
		const { draftChange } = await import("./nodes.ts");
		dashMock(existingDashboard); // file present
		const state = {
			iacRequest: {
				workflow: "dashboard-edit" as const,
				isProd: false,
				cluster: "eu-b2b",
				dashboardSpace: "developer-experience",
				dashboardName: "amazon_bedrock_token_usage",
				dashboardNdjson: NDJSON_1OBJ,
				dashboardAction: "add" as const,
			},
		};
		const result = await draftChange(asIacState(state));
		expect(result.blockedReason).toContain("already exists");
	});

	test("replace blocks when the file is missing", async () => {
		const { draftChange } = await import("./nodes.ts");
		dashMock(NOT_FOUND); // file absent
		const state = {
			iacRequest: {
				workflow: "dashboard-edit" as const,
				isProd: false,
				cluster: "eu-b2b",
				dashboardSpace: "developer-experience",
				dashboardName: "amazon_bedrock_token_usage",
				dashboardNdjson: NDJSON_1OBJ,
				dashboardAction: "replace" as const,
			},
		};
		const result = await draftChange(asIacState(state));
		expect(result.blockedReason).toContain("to replace");
	});

	test("delete is not supported yet -> blocks as a follow-up (no commit)", async () => {
		const { draftChange } = await import("./nodes.ts");
		mockTools({}); // guard fires before repo read
		const state = {
			iacRequest: {
				workflow: "dashboard-edit" as const,
				isProd: false,
				cluster: "eu-b2b",
				dashboardSpace: "developer-experience",
				dashboardName: "amazon_bedrock_token_usage",
				dashboardAction: "delete" as const,
			},
		};
		const result = await draftChange(asIacState(state));
		expect(result.blockedReason).toContain("delete is not supported");
	});

	test("missing required fields block", async () => {
		const { draftChange } = await import("./nodes.ts");
		mockTools({});
		const state = {
			iacRequest: {
				workflow: "dashboard-edit" as const,
				isProd: false,
				cluster: "eu-b2b",
				dashboardName: "x",
				dashboardAction: "add" as const,
				// no dashboardSpace
			},
		};
		const result = await draftChange(asIacState(state));
		expect(result.blockedReason).toContain("space");
	});

	test("path-traversal in a segment blocks before any repo read (SIO-920 guard)", async () => {
		const { draftChange } = await import("./nodes.ts");
		mockTools({}); // no tools -> proves the guard fires before reading
		const state = {
			iacRequest: {
				workflow: "dashboard-edit" as const,
				isProd: false,
				cluster: "eu-b2b",
				dashboardSpace: "../../secrets",
				dashboardName: "x",
				dashboardNdjson: NDJSON_1OBJ,
				dashboardAction: "add" as const,
			},
		};
		const result = await draftChange(asIacState(state));
		expect(result.blockedReason).toContain("invalid");
	});

	test("a non-2xx/non-404 space read blocks (does not guess existence)", async () => {
		const { draftChange } = await import("./nodes.ts");
		// space read errors (e.g. 500 / timeout placeholder) -> UNKNOWN, must block, not proceed
		mockTools({
			gitlab_get_file_content: () => '[500] {"message":"server error"}',
		});
		const state = {
			iacRequest: {
				workflow: "dashboard-edit" as const,
				isProd: false,
				cluster: "eu-b2b",
				dashboardSpace: "developer-experience",
				dashboardName: "amazon_bedrock_token_usage",
				dashboardNdjson: NDJSON_1OBJ,
				dashboardAction: "add" as const,
			},
		};
		const result = await draftChange(asIacState(state));
		expect(result.blockedReason).toContain("Could not verify space");
		expect(result.precheckPassed).toBeUndefined();
	});

	test("a tool-error placeholder on the file read blocks (not treated as 'exists')", async () => {
		const { draftChange } = await import("./nodes.ts");
		// space resolves; the dashboard read returns a callTool error placeholder (not 2xx/404)
		mockTools({
			gitlab_get_file_content: (args) =>
				String(args.filePath ?? "").includes("/spaces/") ? SPACE_FILE : "[gitlab_get_file_content error: ETIMEDOUT]",
		});
		const state = {
			iacRequest: {
				workflow: "dashboard-edit" as const,
				isProd: false,
				cluster: "eu-b2b",
				dashboardSpace: "developer-experience",
				dashboardName: "amazon_bedrock_token_usage",
				dashboardNdjson: NDJSON_1OBJ,
				dashboardAction: "add" as const,
			},
		};
		const result = await draftChange(asIacState(state));
		expect(result.blockedReason).toContain("Could not check dashboard");
		expect(result.precheckPassed).toBeUndefined();
	});

	test("a failed commit blocks (not surfaced as a committed change)", async () => {
		const { draftChange } = await import("./nodes.ts");
		mockTools({
			gitlab_get_file_content: (args) => (String(args.filePath ?? "").includes("/spaces/") ? SPACE_FILE : NOT_FOUND),
			gitlab_create_branch: () => "[201] {}",
			gitlab_commit_file: () => "[gitlab_commit_file error: 500 Internal Server Error]",
		});
		const state = {
			iacRequest: {
				workflow: "dashboard-edit" as const,
				isProd: false,
				cluster: "eu-b2b",
				dashboardSpace: "developer-experience",
				dashboardName: "amazon_bedrock_token_usage",
				dashboardNdjson: NDJSON_1OBJ,
				dashboardAction: "add" as const,
			},
		};
		const result = await draftChange(asIacState(state));
		expect(result.blockedReason).toContain("Could not commit dashboard");
		expect(result.precheckPassed).toBeUndefined();
	});
});

describe("reviewPlan — dashboard", () => {
	test("config-edit kind + MEDIUM display-only risk + dashboard title", async () => {
		const state = {
			iacRequest: {
				workflow: "dashboard-edit" as const,
				isProd: false,
				cluster: "eu-b2b",
				dashboardSpace: "developer-experience",
				dashboardName: "amazon_bedrock_token_usage",
				dashboardAction: "add" as const,
			},
			branch: "b",
			proposedDiff: "(diff)",
			precheckPassed: true,
		};
		const result = await reviewPlan(asIacState(state));
		expect(result.planReview?.kind).toBe("config-edit");
		// title carries the space__name descriptor + the workflow
		expect(result.planReview?.title).toContain("developer-experience__amazon_bedrock_token_usage");
		expect(result.planReview?.title).toContain("dashboard-edit");
		// the risk list mentions the display-only / import-job framing
		expect(result.risks?.some((r) => r.includes("import job"))).toBe(true);
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

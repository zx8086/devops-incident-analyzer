// agent/src/iac/pipeline-status.test.ts
import { describe, expect, test } from "bun:test";
import {
	extractMrIid,
	formatPlanSummary,
	intentFromText,
	isTerminalPipelineStatus,
	parseApprovalState,
	parseNewestPipeline,
	parsePlanReport,
} from "./nodes.ts";

describe("intentFromText (SIO-875 three-way)", () => {
	test("pipeline-status", () => {
		expect(intentFromText("pipeline-status")).toBe("pipeline-status");
		expect(intentFromText("PIPELINE_STATUS")).toBe("pipeline-status");
	});
	test("gitops and info still work", () => {
		expect(intentFromText("gitops")).toBe("gitops");
		expect(intentFromText("info")).toBe("info");
		expect(intentFromText("")).toBe("info");
	});
});

describe("extractMrIid", () => {
	test("reads iid from the create-MR response", () => {
		expect(extractMrIid('[201] {"iid":42,"web_url":"x"}')).toBe(42);
	});
	test("null on missing iid / bad body", () => {
		expect(extractMrIid("[400] {}")).toBeNull();
		expect(extractMrIid("nope")).toBeNull();
	});
});

describe("parseNewestPipeline", () => {
	test("newest-first array -> first element", () => {
		const body = '[200] [{"id":342,"status":"success"},{"id":300,"status":"failed"}]';
		expect(parseNewestPipeline(body)).toEqual({ id: 342, status: "success" });
	});
	test("empty list / bad body -> null", () => {
		expect(parseNewestPipeline("[200] []")).toBeNull();
		expect(parseNewestPipeline("nope")).toBeNull();
	});
});

describe("parsePlanReport", () => {
	test("parses the tf report", () => {
		const body =
			'{"create":0,"update":1,"delete":0,"resources":[{"address":"module.deployments[\\"ap-cld\\"].ec_deployment.this","actions":["update"]}]}';
		const r = parsePlanReport(body);
		expect(r).not.toBeNull();
		expect(r?.update).toBe(1);
		expect(r?.resources[0]?.actions).toEqual(["update"]);
	});
	test("not-ready message -> null", () => {
		expect(parsePlanReport("[no child pipeline yet]")).toBeNull();
	});
});

describe("parseApprovalState", () => {
	test("parses approved/required/by", () => {
		const body = '[200] {"approved":true,"approvals_required":1,"approved_by":[{"user":{"username":"alice"}}]}';
		expect(parseApprovalState(body)).toEqual({ approved: true, required: 1, approvedBy: ["alice"] });
	});
	test("not approved", () => {
		expect(parseApprovalState('[200] {"approved":false,"approved_by":[]}')).toEqual({
			approved: false,
			required: undefined,
			approvedBy: [],
		});
	});
});

describe("isTerminalPipelineStatus", () => {
	test("terminal vs running", () => {
		expect(isTerminalPipelineStatus("success")).toBe(true);
		expect(isTerminalPipelineStatus("failed")).toBe(true);
		expect(isTerminalPipelineStatus("running")).toBe(false);
		expect(isTerminalPipelineStatus("pending")).toBe(false);
	});
});

describe("formatPlanSummary", () => {
	test("counts line", () => {
		expect(formatPlanSummary({ create: 0, update: 1, delete: 0, resources: [] })).toBe(
			"0 create / 1 update / 0 destroy",
		);
		expect(formatPlanSummary(null)).toBe("plan not available");
	});
});

// SIO-877: recover the latest open agent MR when the thread no longer holds one.
import { parseLatestAgentMr } from "./nodes.ts";

describe("parseLatestAgentMr", () => {
	test("returns the newest open agent MR (first element)", () => {
		const body =
			'[200] [{"iid":45,"state":"opened","web_url":"https://gitlab.com/pvhcorp/dhco/observability/observability-elastic-iac/-/merge_requests/45","source_branch":"agent/ap-cld-monitor-9-4-2-version-upgrade-20260602"},' +
			'{"iid":44,"state":"opened","web_url":"x","source_branch":"agent/eu-b2b-..."}]';
		expect(parseLatestAgentMr(body)).toEqual({
			iid: 45,
			webUrl: "https://gitlab.com/pvhcorp/dhco/observability/observability-elastic-iac/-/merge_requests/45",
		});
	});
	test("null when there are no open agent MRs / bad body", () => {
		expect(parseLatestAgentMr("[200] []")).toBeNull();
		expect(parseLatestAgentMr("[gitlab token not configured]")).toBeNull();
		expect(parseLatestAgentMr("nope")).toBeNull();
	});
	test("tolerates a missing web_url", () => {
		expect(parseLatestAgentMr('[200] [{"iid":50}]')).toEqual({ iid: 50, webUrl: "" });
	});
});

// SIO-878: classify a failed plan job's log into a cause hint.
import { classifyPipelineFailure } from "./nodes.ts";

describe("classifyPipelineFailure", () => {
	test("recognises a Terraform state-lock failure", () => {
		const log = "...\nError: Error acquiring the state lock\nError message: HTTP remote state already locked:\n...";
		const hint = classifyPipelineFailure(log);
		expect(hint).toContain("state-lock");
		expect(hint).toContain("shared deployments stack");
		expect(hint).toContain("force-unlock");
	});

	test("generic hint for an unrecognised failure", () => {
		const hint = classifyPipelineFailure('Error: invalid resource attribute "foo" in main.tf');
		expect(hint).toContain("another reason");
	});

	test("no-log hint when the log was unavailable", () => {
		expect(classifyPipelineFailure("[no plan job found in the child pipeline]")).toContain("not available");
		expect(classifyPipelineFailure("")).toContain("not available");
	});
});

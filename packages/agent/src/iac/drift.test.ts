// agent/src/iac/drift.test.ts
import { describe, expect, test } from "bun:test";
import {
	configStackFamily,
	driftFingerprint,
	extractLiveVersion,
	formatDriftSummary,
	parseAgentMrBySourceBranch,
	parseStackPlanResult,
	parseTaskNameList,
	reconcileBranch,
} from "./nodes.ts";
import type { IacStateType } from "./state.ts";

// SIO-882: drift sub-flow pure helpers.

describe("parseTaskNameList", () => {
	test("parses a newline list and drops the exit suffix", () => {
		expect(parseTaskNameList("deployments\nlifecycle-policies\ntemplates\n[exit 0]")).toEqual([
			"deployments",
			"lifecycle-policies",
			"templates",
		]);
	});

	test("skips a header line and strips bullets", () => {
		expect(parseTaskNameList("Available stacks:\n- deployments\n- templates\n")).toEqual(["deployments", "templates"]);
	});

	test("does NOT eat a stack legitimately named 'deployments'", () => {
		expect(parseTaskNameList("deployments\n")).toEqual(["deployments"]);
	});

	test("handles a single space/comma-separated line", () => {
		expect(parseTaskNameList("deployments, lifecycle-policies templates\n[exit 0]")).toEqual([
			"deployments",
			"lifecycle-policies",
			"templates",
		]);
	});
});

describe("parseStackPlanResult", () => {
	test("reads iac_plan's structured JSON", () => {
		const out = JSON.stringify({
			stack: "templates",
			deployment: "gl-testing",
			drifted: true,
			create: 0,
			update: 1,
			delete: 0,
			resources: [],
		});
		expect(parseStackPlanResult(out)).toEqual({ create: 0, update: 1, delete: 0, resources: [] });
	});

	test("returns null on a parseError payload (no counts)", () => {
		const out = JSON.stringify({ stack: "x", deployment: "y", drifted: false, parseError: true, tail: "..." });
		expect(parseStackPlanResult(out)).toBeNull();
	});
});

describe("configStackFamily (defaults)", () => {
	test("maps the config-JSON stacks and treats the rest as HCL", () => {
		expect(configStackFamily("deployments")).toBe("deployment");
		expect(configStackFamily("lifecycle-policies")).toBe("ilm");
		expect(configStackFamily("templates")).toBeNull();
		expect(configStackFamily("topology")).toBeNull();
	});
});

describe("reconcileBranch", () => {
	test("is deterministic and DATE-FREE (idempotent across days)", () => {
		const a = reconcileBranch("gl-testing", "templates", "reconcile-to-json");
		expect(reconcileBranch("gl-testing", "templates", "reconcile-to-json")).toBe(a);
		expect(a).toBe("agent/reconcile-gl-testing-templates-reconcile-to-json");
		expect(a).not.toMatch(/\d{8}/); // no YYYYMMDD date
	});

	test("differs by direction", () => {
		expect(reconcileBranch("gl-testing", "templates", "reconcile-to-live")).not.toBe(
			reconcileBranch("gl-testing", "templates", "reconcile-to-json"),
		);
	});
});

describe("parseAgentMrBySourceBranch", () => {
	test("finds the web_url for a matching source branch", () => {
		const body = `[200] ${JSON.stringify([
			{ source_branch: "agent/reconcile-x", web_url: "https://gl/mr/1" },
			{ source_branch: "other", web_url: "https://gl/mr/2" },
		])}`;
		expect(parseAgentMrBySourceBranch(body, "agent/reconcile-x")).toBe("https://gl/mr/1");
	});

	test("returns empty when no branch matches", () => {
		const body = `[200] ${JSON.stringify([{ source_branch: "other", web_url: "https://gl/mr/2" }])}`;
		expect(parseAgentMrBySourceBranch(body, "agent/reconcile-x")).toBe("");
	});
});

describe("driftFingerprint", () => {
	test("is stable and order-independent for the same drift", () => {
		const a = driftFingerprint({
			create: 0,
			update: 2,
			delete: 0,
			resources: [
				{ address: "b", actions: ["update"] },
				{ address: "a", actions: ["update"] },
			],
		});
		const b = driftFingerprint({
			create: 0,
			update: 2,
			delete: 0,
			resources: [
				{ address: "a", actions: ["update"] },
				{ address: "b", actions: ["update"] },
			],
		});
		expect(a).toBe(b);
	});

	test("changes when the drift changes", () => {
		const a = driftFingerprint({ create: 0, update: 1, delete: 0, resources: [] });
		const b = driftFingerprint({ create: 0, update: 2, delete: 0, resources: [] });
		expect(a).not.toBe(b);
	});
});

describe("extractLiveVersion", () => {
	test("pulls the first semver from a deployment detail blob", () => {
		expect(extractLiveVersion('{"resources":{"elasticsearch":[{"info":{"version":"9.4.2"}}]}}')).toBe("9.4.2");
	});

	test("returns empty when absent", () => {
		expect(extractLiveVersion("{}")).toBe("");
	});
});

describe("formatDriftSummary", () => {
	const drifted = (over: Partial<IacStateType>): IacStateType =>
		({
			targetDeployment: "gl-testing",
			driftReport: {
				deployment: "gl-testing",
				generatedAt: "",
				stacks: [
					{
						stack: "templates",
						drifted: true,
						kind: "hcl",
						create: 0,
						update: 1,
						delete: 0,
						resources: [],
						liveReconcilable: false,
					},
					{
						stack: "deployments",
						drifted: true,
						kind: "config-json",
						create: 0,
						update: 1,
						delete: 0,
						resources: [],
						liveReconcilable: true,
					},
				],
			},
			reconcileResults: [],
			...over,
		}) as unknown as IacStateType;

	test("summarizes opened / skipped per stack", () => {
		const out = formatDriftSummary(
			drifted({
				reconcileResults: [
					{ stack: "templates", direction: "reconcile-to-json", status: "opened", mrUrl: "https://gl/mr/1" },
					{ stack: "deployments", direction: "skip", status: "skipped" },
				],
			}),
		);
		expect(out).toContain("Drift reconcile summary for gl-testing");
		expect(out).toContain("templates: MR opened");
		expect(out).toContain("https://gl/mr/1");
		expect(out).toContain("deployments: skipped");
	});

	test("reports no drift when nothing drifted", () => {
		const state = {
			targetDeployment: "gl-testing",
			driftReport: {
				deployment: "gl-testing",
				generatedAt: "",
				stacks: [
					{
						stack: "x",
						drifted: false,
						kind: "hcl",
						create: 0,
						update: 0,
						delete: 0,
						resources: [],
						liveReconcilable: false,
					},
				],
			},
			reconcileResults: [],
		} as unknown as IacStateType;
		expect(formatDriftSummary(state)).toContain("No drift detected");
	});
});

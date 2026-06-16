// src/tools/ci-contract.test.ts
// SIO-925: pin the CI-artifact contract between the elastic-iac MCP tools and the
// observability-elastic-iac repo. Two layers:
//  1. CI_CONTRACT job-name/artifact defaults match the live .gitlab-ci.yml job set
//     (a repo-side rename trips these tests instead of silently breaking the agent).
//  2. The pure parsers that decode GitLab's pipeline/jobs/bridges API responses on the
//     way to those artifacts behave on representative fixtures.
import { describe, expect, test } from "bun:test";
import { CI_CONTRACT } from "./ci-contract.ts";
import { childPipelineId, findJobByName, parsePipelineRef, planJob } from "./gitlab.ts";

// The on-demand jobs the agent triggers, as they exist in the live repo's
// .gitlab-ci.yml (verified 2026-06-16: drift-check-on-demand:192,
// drift-check-synthetics-on-demand:320, synthetics-push-on-demand:405,
// fleet-upgrade-preview-on-demand:517, fleet-upgrade-apply-on-demand:549).
const LIVE_GITLAB_CI_JOBS = {
	drift: "drift-check-on-demand",
	synthDrift: "drift-check-synthetics-on-demand",
	synthPush: "synthetics-push-on-demand",
	fleetPreview: "fleet-upgrade-preview-on-demand",
	fleetApply: "fleet-upgrade-apply-on-demand",
} as const;

const LIVE_ARTIFACTS = {
	synthDrift: "synthetics-drift-report.json",
	fleetReport: "fleet-upgrade-report.json",
} as const;

describe("CI_CONTRACT job names match the live .gitlab-ci.yml", () => {
	test("on-demand job-name defaults equal the live job set", () => {
		expect(CI_CONTRACT.driftJobName).toBe(LIVE_GITLAB_CI_JOBS.drift);
		expect(CI_CONTRACT.synthDriftJobName).toBe(LIVE_GITLAB_CI_JOBS.synthDrift);
		expect(CI_CONTRACT.synthPushJobName).toBe(LIVE_GITLAB_CI_JOBS.synthPush);
		expect(CI_CONTRACT.fleetPreviewJobName).toBe(LIVE_GITLAB_CI_JOBS.fleetPreview);
		expect(CI_CONTRACT.fleetApplyJobName).toBe(LIVE_GITLAB_CI_JOBS.fleetApply);
	});

	test("artifact-name defaults equal the live artifact set", () => {
		expect(CI_CONTRACT.synthDriftArtifact).toBe(LIVE_ARTIFACTS.synthDrift);
		expect(CI_CONTRACT.fleetReportArtifact).toBe(LIVE_ARTIFACTS.fleetReport);
	});
});

// The terraform-report walk consumes GET /pipelines/:id/bridges then /jobs. Job names in
// the live repo follow plan:<deployment>:<stack> (e.g. plan:eu-b2b:deployments). The
// artifact path is built from the parsed <stack>, so the parser must split it correctly.
describe("planJob parses the live plan:<deployment>:<stack> job name", () => {
	test("returns id + stack for a deployments plan job", () => {
		const jobs = [
			{ id: 9001, name: "validate:eu-b2b" },
			{ id: 9002, name: "plan:eu-b2b:deployments" },
		];
		expect(planJob(jobs)).toEqual({ id: 9002, stack: "deployments" });
	});

	test("parses a lifecycle-policies stack too", () => {
		expect(planJob([{ id: 7, name: "plan:eu-cld:lifecycle-policies" }])).toEqual({
			id: 7,
			stack: "lifecycle-policies",
		});
	});

	test("null when no plan job is present yet", () => {
		expect(planJob([{ id: 1, name: "build" }])).toBeNull();
	});
});

describe("childPipelineId walks the parent->child bridge", () => {
	test("returns the downstream pipeline id", () => {
		const bridges = [{ name: "trigger-child", downstream_pipeline: { id: 555, status: "running" } }];
		expect(childPipelineId(bridges)).toBe(555);
	});

	test("null before the downstream pipeline exists", () => {
		expect(childPipelineId([{ name: "trigger-child", downstream_pipeline: null }])).toBeNull();
	});
});

describe("findJobByName resolves the on-demand job from the live job set", () => {
	test("finds the drift-check-on-demand job id by the contract name", () => {
		const jobs = [
			{ id: 100, name: "noise" },
			{ id: 101, name: CI_CONTRACT.driftJobName },
		];
		expect(findJobByName(jobs, CI_CONTRACT.driftJobName)).toBe(101);
	});

	test("finds the fleet-upgrade-apply-on-demand job id", () => {
		const jobs = [{ id: 202, name: CI_CONTRACT.fleetApplyJobName }];
		expect(findJobByName(jobs, CI_CONTRACT.fleetApplyJobName)).toBe(202);
	});

	test("null when the named job is absent (pipeline still spinning up)", () => {
		expect(findJobByName([{ id: 1, name: "other" }], CI_CONTRACT.synthPushJobName)).toBeNull();
	});
});

describe("parsePipelineRef reads the create-pipeline response envelope", () => {
	test("extracts id + status from a [201] {json} trigger response", () => {
		expect(parsePipelineRef('[201] {"id":4242,"status":"created","ref":"main"}')).toEqual({
			id: 4242,
			status: "created",
		});
	});

	test("defaults status to created when absent", () => {
		expect(parsePipelineRef('[201] {"id":7}')).toEqual({ id: 7, status: "created" });
	});

	test("null on a non-JSON / error body", () => {
		expect(parsePipelineRef("[500] internal error")).toBeNull();
	});
});

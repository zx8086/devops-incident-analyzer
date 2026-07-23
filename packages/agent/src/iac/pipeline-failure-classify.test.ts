// agent/src/iac/pipeline-failure-classify.test.ts
// SIO-1185: the failure taxonomy (state-lock | flaky | lint | environment | real | unknown)
// adapted from gitlab-org/ai/skills gitlab-babysit-mr onto this repo's CI log signals.

import { describe, expect, test } from "bun:test";
import { classifyPipelineFailure, classifyPipelineFailureDetail } from "./fleet-apply-result.ts";

describe("classifyPipelineFailureDetail (SIO-1185)", () => {
	test("state lock wins over everything and keeps the SIO-878 hint", () => {
		const r = classifyPipelineFailureDetail("Error acquiring the state lock: timeout while waiting");
		expect(r.failureClass).toBe("state-lock");
		expect(r.hint).toContain("state-lock");
		// the flaky signal "timeout" in the same log must NOT demote the class
	});

	test("stateLocked flag forces state-lock even without the log signature", () => {
		const r = classifyPipelineFailureDetail("some unrelated tail", true);
		expect(r.failureClass).toBe("state-lock");
	});

	test("missing or placeholder log -> unknown with the log-unavailable hint", () => {
		expect(classifyPipelineFailureDetail("").failureClass).toBe("unknown");
		const r = classifyPipelineFailureDetail("[gitlab_get_pipeline_plan_log error: 404]");
		expect(r.failureClass).toBe("unknown");
		expect(r.hint).toContain("not available");
	});

	test("terraform fmt violations -> lint with task fmt advice", () => {
		const r = classifyPipelineFailureDetail("main.tf is not properly formatted. Run terraform fmt.");
		expect(r.failureClass).toBe("lint");
		expect(r.hint).toContain("task fmt");
	});

	test("SIO-905 env-scope credential failure -> environment, not this change", () => {
		const r = classifyPipelineFailureDetail("authwriter: one of apikey or username and password must be specified");
		expect(r.failureClass).toBe("environment");
		expect(r.hint).toContain("not this change");
	});

	test("runner OOM SIGKILL -> flaky with retry advice", () => {
		const r = classifyPipelineFailureDetail("terraform init interrupted: signal: killed (OOM)");
		expect(r.failureClass).toBe("flaky");
		expect(r.hint).toContain("Retry the pipeline");
	});

	test("connection reset during provider download -> flaky", () => {
		expect(classifyPipelineFailureDetail("read tcp: connection reset by peer").failureClass).toBe("flaky");
	});

	test("terraform config error -> real with never-retry advice", () => {
		const r = classifyPipelineFailureDetail(
			'Error: Unsupported argument\n  on main.tf line 4: "sizee" is not expected',
		);
		expect(r.failureClass).toBe("real");
		expect(r.hint).toContain("retrying will not help");
	});

	test("undiagnosable tail -> unknown with the review-the-log hint", () => {
		const r = classifyPipelineFailureDetail("Job succeeded... wait no it did not");
		expect(r.failureClass).toBe("unknown");
		expect(r.hint).toContain("review the job log");
	});

	test("back-compat string form returns the detail hint verbatim", () => {
		const log = "Error acquiring the state lock";
		expect(classifyPipelineFailure(log)).toBe(classifyPipelineFailureDetail(log).hint);
	});
});

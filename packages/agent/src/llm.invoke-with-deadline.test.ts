// packages/agent/src/llm.invoke-with-deadline.test.ts
//
// SIO-739: per-role deadline lookup + invokeWithDeadline helper.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { DeadlineExceededError, ROLE_DEADLINES_MS, getRoleDeadlineMs, invokeWithDeadline } from "./llm.ts";

const ORIG_ENV = { ...process.env };

beforeEach(() => {
	process.env = { ...ORIG_ENV };
});

afterEach(() => {
	process.env = { ...ORIG_ENV };
});

describe("ROLE_DEADLINES_MS defaults", () => {
	test("mitigation default is 120000", () => {
		expect(ROLE_DEADLINES_MS.mitigation).toBe(120_000);
	});

	test("actionProposal default is 60000", () => {
		expect(ROLE_DEADLINES_MS.actionProposal).toBe(60_000);
	});

	test("followUp default is 60000", () => {
		expect(ROLE_DEADLINES_MS.followUp).toBe(60_000);
	});

	test("classifier default is 0 (no per-call timer)", () => {
		expect(ROLE_DEADLINES_MS.classifier).toBe(0);
	});
});

describe("getRoleDeadlineMs", () => {
	test("returns map default when no env var set", () => {
		delete process.env.AGENT_LLM_TIMEOUT_MITIGATION_MS;
		expect(getRoleDeadlineMs("mitigation")).toBe(120_000);
	});

	test("env override takes precedence", () => {
		process.env.AGENT_LLM_TIMEOUT_MITIGATION_MS = "5000";
		expect(getRoleDeadlineMs("mitigation")).toBe(5000);
	});

	test("env override of 0 is honoured (disables per-call timer)", () => {
		process.env.AGENT_LLM_TIMEOUT_FOLLOWUP_MS = "0";
		expect(getRoleDeadlineMs("followUp")).toBe(0);
	});

	test("non-numeric env value falls through to map default", () => {
		process.env.AGENT_LLM_TIMEOUT_MITIGATION_MS = "nope";
		expect(getRoleDeadlineMs("mitigation")).toBe(120_000);
	});

	test("negative env value falls through to map default", () => {
		process.env.AGENT_LLM_TIMEOUT_MITIGATION_MS = "-1";
		expect(getRoleDeadlineMs("mitigation")).toBe(120_000);
	});
});

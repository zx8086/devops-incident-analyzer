// packages/agent/src/llm.invoke-with-deadline.test.ts
//
// SIO-739: per-role deadline lookup + invokeWithDeadline helper.

import { describe, expect, test } from "bun:test";
// biome-ignore lint/correctness/noUnusedImports: SIO-739 Task 2 will add invokeWithDeadline + DeadlineExceededError usage
import { DeadlineExceededError, getRoleDeadlineMs, invokeWithDeadline, ROLE_DEADLINES_MS } from "./llm.ts";

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
	test("returns map default when env has no relevant key", () => {
		expect(getRoleDeadlineMs("mitigation", {})).toBe(120_000);
	});

	test("env override takes precedence", () => {
		expect(getRoleDeadlineMs("mitigation", { AGENT_LLM_TIMEOUT_MITIGATION_MS: "5000" })).toBe(5000);
	});

	test("env override of 0 is honoured (disables per-call timer)", () => {
		expect(getRoleDeadlineMs("followUp", { AGENT_LLM_TIMEOUT_FOLLOW_UP_MS: "0" })).toBe(0);
	});

	test("non-numeric env value falls through to map default", () => {
		expect(getRoleDeadlineMs("mitigation", { AGENT_LLM_TIMEOUT_MITIGATION_MS: "nope" })).toBe(120_000);
	});

	test("negative env value falls through to map default", () => {
		expect(getRoleDeadlineMs("mitigation", { AGENT_LLM_TIMEOUT_MITIGATION_MS: "-1" })).toBe(120_000);
	});

	test("empty string env value falls through to map default", () => {
		expect(getRoleDeadlineMs("mitigation", { AGENT_LLM_TIMEOUT_MITIGATION_MS: "" })).toBe(120_000);
	});

	test("camelCase role names use SCREAMING_SNAKE env keys", () => {
		expect(getRoleDeadlineMs("followUp", { AGENT_LLM_TIMEOUT_FOLLOW_UP_MS: "1234" })).toBe(1234);
		expect(getRoleDeadlineMs("actionProposal", { AGENT_LLM_TIMEOUT_ACTION_PROPOSAL_MS: "2345" })).toBe(2345);
		expect(getRoleDeadlineMs("runbookSelector", { AGENT_LLM_TIMEOUT_RUNBOOK_SELECTOR_MS: "3456" })).toBe(3456);
	});

	test("falls through to map default for camelCase role when no env key present", () => {
		expect(getRoleDeadlineMs("followUp", {})).toBe(60_000);
	});
});

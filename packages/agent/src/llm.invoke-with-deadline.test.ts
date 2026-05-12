// packages/agent/src/llm.invoke-with-deadline.test.ts
//
// SIO-739: per-role deadline lookup + invokeWithDeadline helper.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	DeadlineExceededError,
	getRoleDeadlineMs,
	type InvokableLlm,
	invokeWithDeadline,
	ROLE_DEADLINES_MS,
} from "./llm.ts";

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

describe("invokeWithDeadline", () => {
	type FakeLlm = InvokableLlm;

	const ORIG_ENV = { ...process.env };

	beforeEach(() => {
		process.env = { ...ORIG_ENV };
	});

	afterEach(() => {
		process.env = { ...ORIG_ENV };
	});

	test("resolves before deadline → returns response", async () => {
		process.env.AGENT_LLM_TIMEOUT_MITIGATION_MS = "200";
		const llm: FakeLlm = {
			invoke: async () => {
				await Bun.sleep(10);
				return { content: "ok" };
			},
		};
		const result = await invokeWithDeadline(llm, "mitigation", []);
		expect((result as { content: string }).content).toBe("ok");
	});

	test("rejects with non-abort error → rethrows unchanged, NOT DeadlineExceededError", async () => {
		process.env.AGENT_LLM_TIMEOUT_MITIGATION_MS = "200";
		const llm: FakeLlm = {
			invoke: async () => {
				throw new Error("boom");
			},
		};
		await expect(invokeWithDeadline(llm, "mitigation", [])).rejects.toThrow("boom");
	});

	test("hangs past deadline → throws DeadlineExceededError with role + deadlineMs", async () => {
		process.env.AGENT_LLM_TIMEOUT_MITIGATION_MS = "50";
		const llm: FakeLlm = {
			invoke: async (_messages, config) => {
				return await new Promise((_resolve, reject) => {
					config?.signal?.addEventListener("abort", () => {
						const err = new Error("Aborted");
						err.name = "AbortError";
						reject(err);
					});
				});
			},
		};
		let caught: unknown;
		try {
			await invokeWithDeadline(llm, "mitigation", []);
		} catch (err) {
			caught = err;
		}
		expect(caught).toBeInstanceOf(DeadlineExceededError);
		expect((caught as DeadlineExceededError).role).toBe("mitigation");
		expect((caught as DeadlineExceededError).deadlineMs).toBe(50);
	});

	test("external signal aborts first → rethrows AbortError, NOT DeadlineExceededError", async () => {
		process.env.AGENT_LLM_TIMEOUT_MITIGATION_MS = "1000";
		const external = new AbortController();
		external.abort();
		const llm: FakeLlm = {
			invoke: async (_messages, config) => {
				return await new Promise((_resolve, reject) => {
					if (config?.signal?.aborted) {
						const err = new Error("Aborted by external signal");
						err.name = "AbortError";
						reject(err);
						return;
					}
					config?.signal?.addEventListener("abort", () => {
						const err = new Error("Aborted by external signal");
						err.name = "AbortError";
						reject(err);
					});
				});
			},
		};
		let caught: unknown;
		try {
			await invokeWithDeadline(llm, "mitigation", [], { signal: external.signal });
		} catch (err) {
			caught = err;
		}
		expect(caught).toBeInstanceOf(Error);
		expect(caught).not.toBeInstanceOf(DeadlineExceededError);
		expect((caught as Error).name).toBe("AbortError");
	});

	test("deadline = 0 → no local timer, llm.invoke runs without per-call abort", async () => {
		process.env.AGENT_LLM_TIMEOUT_CLASSIFIER_MS = "0";
		const llm: FakeLlm = {
			invoke: async (_messages, config) => {
				// If a local timer fired, signal would be aborted; assert it stays open
				await Bun.sleep(80);
				expect(config?.signal?.aborted ?? false).toBe(false);
				return { content: "ok" };
			},
		};
		const result = await invokeWithDeadline(llm, "classifier", []);
		expect((result as { content: string }).content).toBe("ok");
	});
});

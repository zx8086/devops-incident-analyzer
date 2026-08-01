// agent/src/close-detect.test.ts

import { describe, expect, test } from "bun:test";
import { HumanMessage } from "@langchain/core/messages";
import { classify } from "./classifier.ts";
import { detectCloseCommand } from "./close-detect.ts";
import type { AgentStateType } from "./state.ts";

describe("SIO-1357 detectCloseCommand", () => {
	test("matches the canonical command, any case", () => {
		expect(detectCloseCommand("close incident")).toBe(true);
		expect(detectCloseCommand("Close Incident")).toBe(true);
		expect(detectCloseCommand("CLOSE INCIDENT")).toBe(true);
	});

	test("tolerates surrounding whitespace", () => {
		expect(detectCloseCommand("  close incident  ")).toBe(true);
	});

	test("rejects trailing or leading prose (whole-message command only)", () => {
		expect(detectCloseCommand("close incident please")).toBe(false);
		expect(detectCloseCommand("can you close incident")).toBe(false);
		expect(detectCloseCommand("this incident is closed")).toBe(false);
	});

	test("rejects an empty or unrelated message", () => {
		expect(detectCloseCommand("")).toBe(false);
		expect(detectCloseCommand("check kafka consumer lag")).toBe(false);
	});
});

describe("SIO-1357 classify close-command routing", () => {
	test("a close command sets closeIncidentRequested and short-circuits to simple (regex path, no LLM)", async () => {
		const state = { messages: [new HumanMessage("close incident")] } as unknown as AgentStateType;
		const result = await classify(state);
		expect(result.closeIncidentRequested).toBe(true);
		// SIO-1357: routes SIMPLE (not complex) -- closing an incident must not
		// re-run the full fan-out/aggregate pipeline.
		expect(result.queryComplexity).toBe("simple");
	});

	test("snapshots the PRIOR finalAnswer into closingReport before this turn can overwrite it", async () => {
		const state = {
			messages: [new HumanMessage("close incident")],
			finalAnswer: "the prior investigation's report",
		} as unknown as AgentStateType;
		const result = await classify(state);
		expect(result.closingReport).toBe("the prior investigation's report");
	});

	test("a normal complex query clears closeIncidentRequested and closingReport via turnReset", async () => {
		const state = {
			messages: [new HumanMessage("check kafka consumer lag")],
			finalAnswer: "stale report from a prior closed incident",
		} as unknown as AgentStateType;
		const result = await classify(state);
		expect(result.closeIncidentRequested).toBe(false);
		expect(result.closingReport).toBe("");
	});

	// The close command must not perturb the unrelated HIL learn lane, and vice
	// versa -- both are whole-message-strict detectors checked independently.
	test("a learn command does not set closeIncidentRequested", async () => {
		const state = { messages: [new HumanMessage("learn from DEVOPS-1355")] } as unknown as AgentStateType;
		const result = await classify(state);
		expect(result.hilLearnTicketKey).toBe("DEVOPS-1355");
		expect(result.closeIncidentRequested).toBe(false);
	});

	test("a close command does not set hilLearnTicketKey", async () => {
		const state = { messages: [new HumanMessage("close incident")] } as unknown as AgentStateType;
		const result = await classify(state);
		expect(result.hilLearnTicketKey).toBeUndefined();
	});
});

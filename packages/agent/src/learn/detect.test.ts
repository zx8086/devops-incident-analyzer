// agent/src/learn/detect.test.ts

import { describe, expect, test } from "bun:test";
import { HumanMessage } from "@langchain/core/messages";
import { classify } from "../classifier.ts";
import type { AgentStateType } from "../state.ts";
import { detectLearnCommand } from "./detect.ts";

describe("SIO-1126 detectLearnCommand", () => {
	test("matches the canonical command and uppercases the key", () => {
		expect(detectLearnCommand("learn from DEVOPS-1355")).toBe("DEVOPS-1355");
		expect(detectLearnCommand("learn from devops-1355")).toBe("DEVOPS-1355");
		expect(detectLearnCommand("  Learn From ml-1194  ")).toBe("ML-1194");
	});

	test("tolerates alphanumeric project keys", () => {
		expect(detectLearnCommand("learn from A1B2-42")).toBe("A1B2-42");
	});

	test("rejects trailing or leading prose (whole-message command only)", () => {
		expect(detectLearnCommand("learn from DEVOPS-1355 please")).toBeNull();
		expect(detectLearnCommand("can you learn from DEVOPS-1355")).toBeNull();
	});

	test("rejects non-ticket arguments", () => {
		expect(detectLearnCommand("learn from this incident")).toBeNull();
		expect(detectLearnCommand("learn from 1234")).toBeNull();
		expect(detectLearnCommand("learn from DEVOPS-")).toBeNull();
		expect(detectLearnCommand("")).toBeNull();
	});
});

describe("SIO-1126 classify learn-command routing", () => {
	test("a learn command sets hilLearnTicketKey (regex path, no LLM)", async () => {
		const state = { messages: [new HumanMessage("learn from DEVOPS-1355")] } as unknown as AgentStateType;
		const result = await classify(state);
		expect(result.hilLearnTicketKey).toBe("DEVOPS-1355");
		expect(result.queryComplexity).toBe("complex");
	});

	test("a normal complex query clears hilLearnTicketKey via turnReset", async () => {
		const state = { messages: [new HumanMessage("check kafka consumer lag")] } as unknown as AgentStateType;
		const result = await classify(state);
		// The key is explicitly reset so a prior turn's learn command never leaks.
		expect("hilLearnTicketKey" in result).toBe(true);
		expect(result.hilLearnTicketKey).toBeUndefined();
		expect(result.queryComplexity).toBe("complex");
	});
});

// agent/src/iac/converse.test.ts
// SIO-930: the conversational follow-up lane. intentFromText maps "converse";
// coerceConverseIntent gates it on a real follow-up turn; converseIac answers from full
// history over the read-only tool subset and never drafts/opens an MR.
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { coerceConverseIntent, intentFromText } from "./nodes.ts";
import type { IacStateType } from "./state.ts";

const asIacState = (partial: Partial<IacStateType>): IacStateType => partial as unknown as IacStateType;

// SIO-939: converseIac calls buildSystemPrompt(getAgentByName(AGENT)), which
// reads agent.skills/sharedSkills (Maps) + knowledge (array). Several sibling
// tests mock.module("../prompt-context.ts") with an incomplete getAgent stub
// (`{ manifest: {} }`, no skills); Bun's mock.module is process-global +
// last-wins, so without owning our own mock here the suite-run resolves the
// stub and `agent.skills.keys()` throws. Own a COMPLETE stub and re-assert it in
// beforeEach so load order cannot leak (the SIO-635 / lifecycle.test.ts pattern).
const AGENT_STUB = {
	manifest: {},
	skills: new Map<string, string>(),
	sharedSkills: new Map<string, string>(),
	knowledge: [] as string[],
	soul: undefined,
	rules: undefined,
	duties: undefined,
	sharedContext: undefined,
};

function installPromptContextMock(): void {
	mock.module("../prompt-context.ts", () => ({
		getAgent: () => AGENT_STUB,
		getAgentByName: () => AGENT_STUB,
	}));
}
installPromptContextMock();

beforeEach(() => {
	// Re-assert so a sibling file's load-time prompt-context mock cannot win.
	installPromptContextMock();
});

describe("intentFromText converse (SIO-930)", () => {
	test("maps an explicit converse reply to converse", () => {
		expect(intentFromText("converse")).toBe("converse");
		expect(intentFromText("CONVERSE")).toBe("converse");
		expect(intentFromText("the answer is converse")).toBe("converse");
	});

	test("converse does not steal the other intents", () => {
		expect(intentFromText("gitops")).toBe("gitops");
		expect(intentFromText("pipeline-status")).toBe("pipeline-status");
		expect(intentFromText("drift")).toBe("drift");
		expect(intentFromText("info")).toBe("info");
	});
});

describe("coerceConverseIntent (SIO-930)", () => {
	test("keeps converse on a follow-up turn", () => {
		expect(coerceConverseIntent("converse", true)).toBe("converse");
	});

	test("downgrades converse to info on a first turn", () => {
		expect(coerceConverseIntent("converse", false)).toBe("info");
	});

	test("never touches a non-converse intent", () => {
		expect(coerceConverseIntent("gitops", true)).toBe("gitops");
		expect(coerceConverseIntent("gitops", false)).toBe("gitops");
		expect(coerceConverseIntent("pipeline-status", false)).toBe("pipeline-status");
	});
});

describe("converseIac (SIO-930)", () => {
	test("answers from history with no tool calls and never blocks/MRs", async () => {
		// Mock the LLM to return a no-tool-call AIMessage (the common case: pure explanation).
		mock.module("../llm.ts", () => ({
			createLlm: () => ({ invoke: async () => new AIMessage("The delete phase had no delete action.") }),
			createLlmWithTools: () => ({
				invoke: async () => new AIMessage({ content: "The delete phase had no delete action.", tool_calls: [] }),
			}),
		}));
		// Mock the MCP bridge so infoTools() returns an empty set (no network).
		mock.module("../mcp-bridge.ts", () => ({
			getToolsForDataSource: () => [],
			getConnectedServers: () => ["elastic-iac-mcp"],
		}));
		const { converseIac } = await import("./nodes.ts");

		const state = asIacState({
			isFollowUp: true,
			messages: [
				new HumanMessage("propose a tiered ILM policy"),
				new AIMessage("Here is a policy with hot/warm/cold/delete."),
				new HumanMessage("why was that config wrong?"),
			],
		});
		const out = await converseIac(state);

		expect(out.messages?.length).toBe(1);
		expect(String(out.messages?.[0]?.content)).toContain("delete");
		// explain-only: never sets a blocked reason, never opens an MR
		expect(out.blockedReason).toBeUndefined();
		expect(out.mrUrl).toBeUndefined();
	});
});

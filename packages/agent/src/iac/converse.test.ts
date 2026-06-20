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

// SIO-981: the classifier must derive "is this a follow-up?" from the conversation history (a prior
// AIMessage present), not only from the UI-supplied state.isFollowUp flag. Otherwise a follow-up
// like "why was that wrong?" gets coerced converse->info (read-only refusal) whenever the UI omits
// the flag. The classifier also sees recent history so the LLM can recognise the follow-up.
describe("classifyIacIntent follow-up from history (SIO-981)", () => {
	function mockClassifierReturning(word: string): void {
		mock.module("../llm.ts", () => ({
			createLlm: () => ({ invoke: async () => new AIMessage(word) }),
			createLlmWithTools: () => ({ invoke: async () => new AIMessage({ content: word, tool_calls: [] }) }),
		}));
	}

	test("keeps converse when a prior AIMessage exists, even with isFollowUp unset", async () => {
		mockClassifierReturning("converse");
		const { classifyIacIntent } = await import("./nodes.ts");
		const state = asIacState({
			// isFollowUp intentionally NOT set (UI omitted it) -- history must drive the decision.
			messages: [
				new HumanMessage("set total_shards_per_node to 3 on logs@custom on eu-b2b"),
				new AIMessage("Proposed: total_shards_per_node -> 3 on logs@custom."),
				new HumanMessage("why did you pick that value?"),
			],
		});
		const out = await classifyIacIntent(state);
		expect(out.intent).toBe("converse");
	});

	test("still downgrades converse->info on a true first turn (no prior AIMessage)", async () => {
		mockClassifierReturning("converse");
		const { classifyIacIntent } = await import("./nodes.ts");
		const state = asIacState({
			messages: [new HumanMessage("why was that config wrong?")], // first message, no prior answer
		});
		const out = await classifyIacIntent(state);
		expect(out.intent).toBe("info");
	});

	test("a fresh gitops request with history present still classifies gitops (no regression)", async () => {
		mockClassifierReturning("gitops");
		const { classifyIacIntent } = await import("./nodes.ts");
		const state = asIacState({
			messages: [
				new HumanMessage("what version is eu-b2b running?"),
				new AIMessage("eu-b2b is on 9.4.1."),
				new HumanMessage("upgrade eu-b2b to 9.4.2"),
			],
		});
		const out = await classifyIacIntent(state);
		expect(out.intent).toBe("gitops");
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

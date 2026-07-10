// agent/src/iac/mr-create.test.ts
// SIO-1062: openMr must never store a create-MR error body as mrUrl. A 409 (an open MR
// already exists for the deterministic branch) recovers and reuses the existing MR; any
// other failure ends the turn via blockedReason (graph.ts routes it to END).
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { AIMessage } from "@langchain/core/messages";
import type { IacStateType } from "./state.ts";

const asIacState = (partial: Partial<IacStateType>): IacStateType => partial as unknown as IacStateType;

// Complete prompt-context stub owned by this file (the SIO-939 / converse.test.ts pattern):
// buildMrDescription reads agent.skills/sharedSkills (Maps) + knowledge; an incomplete
// sibling stub would throw inside its try/catch and silently flip to the fallback body.
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

function installLlmMock(): void {
	mock.module("../llm.ts", () => ({
		createLlm: () => ({ invoke: async () => new AIMessage("MR body") }),
		createLlmWithTools: () => ({ invoke: async () => new AIMessage({ content: "MR body", tool_calls: [] }) }),
	}));
}
installLlmMock();

// Fake tool set so callTool() inside nodes.ts resolves against our stubs (ilm-rollout.test.ts pattern).
function mockTools(handlers: Record<string, (args: Record<string, unknown>) => string>) {
	const tools = Object.entries(handlers).map(([name, fn]) => ({
		name,
		invoke: async (args: Record<string, unknown>) => fn(args),
	}));
	mock.module("../mcp-bridge.ts", () => ({
		getToolsForDataSource: () => tools,
		getConnectedServers: () => ["elastic-iac-mcp"],
	}));
}

beforeEach(() => {
	// Re-assert so a sibling file's load-time mocks cannot win.
	installPromptContextMock();
	installLlmMock();
});

const BLOB_409 = '[409] {"message":["Another open merge request already exists for this source branch: !256"]}';
const REAL_URL = "https://gitlab.com/x/-/merge_requests/256";

function baseState(over: Partial<IacStateType> = {}): IacStateType {
	return asIacState({
		branch: "eu-b2b-9-4-2-version-upgrade",
		requestId: "req-1",
		proposedFiles: [],
		planReview: {
			title: "Upgrade eu-b2b to 9.4.2",
			diff: "-9.4.1\n+9.4.2",
			plan: "1 update",
			risks: [],
			approvedBy: [],
		} as unknown as IacStateType["planReview"],
		iacRequest: { workflow: "version-upgrade", cluster: "eu-b2b", version: "9.4.2", isProd: false },
		...over,
	});
}

describe("openMr (SIO-1062)", () => {
	test("created: stores web_url + iid (unchanged happy path)", async () => {
		const { openMr } = await import("./nodes.ts");
		mockTools({
			gitlab_create_merge_request: () => `[201] {"web_url":"${REAL_URL}","iid":256}`,
		});
		const result = await openMr(baseState());
		expect(result.mrUrl).toBe(REAL_URL);
		expect(result.mrIid).toBe(256);
		expect(result.blockedReason).toBeUndefined();
	});

	test("non-2xx: blocks the turn, stores NO mrUrl (the 409-blob poisoning regression)", async () => {
		const { openMr } = await import("./nodes.ts");
		mockTools({
			gitlab_create_merge_request: () => '[500] {"message":"boom"}',
		});
		const result = await openMr(baseState());
		expect(result.mrUrl).toBeUndefined();
		expect(result.blockedReason).toContain("MR creation failed");
		expect(result.messages?.length).toBe(1);
	});

	test("2xx body without web_url: blocks (never a garbage url)", async () => {
		const { openMr } = await import("./nodes.ts");
		mockTools({
			gitlab_create_merge_request: () => '[201] {"iid":41}',
		});
		const result = await openMr(baseState());
		expect(result.mrUrl).toBeUndefined();
		expect(result.blockedReason).toContain("MR creation failed");
	});

	test("409 with !NNN: recovers the existing MR by iid and proceeds idempotently", async () => {
		const { openMr } = await import("./nodes.ts");
		const getMrCalls: Array<Record<string, unknown>> = [];
		mockTools({
			gitlab_create_merge_request: () => BLOB_409,
			gitlab_get_merge_request: (args) => {
				getMrCalls.push(args);
				return `[200] {"state":"opened","web_url":"${REAL_URL}","iid":256}`;
			},
		});
		const result = await openMr(baseState());
		expect(getMrCalls).toEqual([{ iid: 256 }]);
		expect(result.mrUrl).toBe(REAL_URL);
		expect(result.mrIid).toBe(256);
		expect(result.blockedReason).toBeUndefined();
	});

	test("409 recovery repairs the activeChange amend lane (mrUrl + mrIid merged in)", async () => {
		const { openMr } = await import("./nodes.ts");
		mockTools({
			gitlab_create_merge_request: () => BLOB_409,
			gitlab_get_merge_request: () => `[200] {"state":"opened","web_url":"${REAL_URL}","iid":256}`,
		});
		const activeChange = {
			mrUrl: "",
			mrIid: undefined,
			updatedAtTurn: "req-0",
		} as unknown as NonNullable<IacStateType["activeChange"]>;
		const result = await openMr(baseState({ activeChange }));
		expect(result.activeChange?.mrUrl).toBe(REAL_URL);
		expect(result.activeChange?.mrIid).toBe(256);
	});

	test("409 without !NNN: falls back to the agent-MR list scan by source branch", async () => {
		const { openMr } = await import("./nodes.ts");
		mockTools({
			gitlab_create_merge_request: () => '[409] {"message":["Conflict"]}',
			gitlab_list_agent_merge_requests: () =>
				`[200] [{"source_branch":"other-branch","web_url":"https://gitlab.com/x/-/merge_requests/9"},` +
				`{"source_branch":"eu-b2b-9-4-2-version-upgrade","web_url":"${REAL_URL}"}]`,
		});
		const result = await openMr(baseState());
		expect(result.mrUrl).toBe(REAL_URL);
		expect(result.mrIid).toBe(256); // derived from the recovered url
		expect(result.blockedReason).toBeUndefined();
	});

	test("409 with an unresolvable MR: blocks instead of storing the blob", async () => {
		const { openMr } = await import("./nodes.ts");
		mockTools({
			gitlab_create_merge_request: () => '[409] {"message":["Conflict"]}',
			gitlab_list_agent_merge_requests: () => "[200] []",
		});
		const result = await openMr(baseState());
		expect(result.mrUrl).toBeUndefined();
		expect(result.blockedReason).toContain("could not be resolved");
	});
});

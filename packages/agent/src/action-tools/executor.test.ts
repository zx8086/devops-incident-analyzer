// agent/src/action-tools/executor.test.ts
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { PendingAction } from "@devops-agent/shared";
import { executeAction, getAvailableActionTools } from "./executor.ts";

// Mock at the network boundary (SDKs), not sibling modules.
// Sibling-module mocks via mock.module leak across test files in the same
// Bun process and pollute ticket-creator.test.ts / slack-notifier.test.ts.
const mockSlackPostMessage = mock(() => Promise.resolve({ ok: true, ts: "123.456", channel: "C123" }));
const mockSlackFilesUpload = mock(() => Promise.resolve({ ok: true }));

mock.module("@slack/web-api", () => ({
	WebClient: class {
		chat = { postMessage: mockSlackPostMessage };
		files = { uploadV2: mockSlackFilesUpload };
	},
}));

const mockLinearCreateIssue = mock(() =>
	Promise.resolve({
		success: true,
		issue: Promise.resolve({
			id: "ISSUE-executor-123",
			identifier: "INC-executor-1",
			url: "https://linear.app/team/issue/INC-executor-1",
		}),
	}),
);
const mockLinearCreateAttachment = mock(() => Promise.resolve({ success: true }));

mock.module("@linear/sdk", () => ({
	LinearClient: class {
		createIssue = mockLinearCreateIssue;
		createAttachment = mockLinearCreateAttachment;
	},
}));

describe("executor", () => {
	const originalEnv = { ...process.env };

	beforeEach(() => {
		process.env.SLACK_BOT_TOKEN = "xoxb-test";
		process.env.SLACK_DEFAULT_CHANNEL = "#test";
		process.env.LINEAR_API_KEY = "lin_api_test";
		process.env.LINEAR_TEAM_ID = "team-id";
		process.env.LINEAR_PROJECT_ID = "project-id";
		mockSlackPostMessage.mockClear();
		mockSlackFilesUpload.mockClear();
		mockLinearCreateIssue.mockClear();
		mockLinearCreateAttachment.mockClear();
	});

	afterEach(() => {
		process.env = { ...originalEnv };
	});

	test("getAvailableActionTools returns both when configured", () => {
		const tools = getAvailableActionTools();
		expect(tools).toContain("notify-slack");
		expect(tools).toContain("create-ticket");
	});

	test("getAvailableActionTools excludes unconfigured tools", () => {
		delete process.env.SLACK_BOT_TOKEN;
		const tools = getAvailableActionTools();
		expect(tools).not.toContain("notify-slack");
		expect(tools).toContain("create-ticket");
	});

	test("getAvailableActionTools returns empty when nothing configured", () => {
		delete process.env.SLACK_BOT_TOKEN;
		delete process.env.SLACK_DEFAULT_CHANNEL;
		delete process.env.LINEAR_API_KEY;
		const tools = getAvailableActionTools();
		expect(tools).toEqual([]);
	});

	test("executeAction routes notify-slack correctly", async () => {
		const action: PendingAction = {
			id: "action-1",
			tool: "notify-slack",
			params: { channel: "#alerts", message: "Test", severity: "critical" },
			reason: "High severity incident",
		};

		const result = await executeAction(action, {
			reportContent: "Full report",
			threadId: "thread-1",
		});

		expect(result.status).toBe("success");
		expect(result.tool).toBe("notify-slack");
		expect(result.actionId).toBe("action-1");
		expect(mockSlackPostMessage).toHaveBeenCalledTimes(1);
	});

	test("executeAction routes create-ticket correctly", async () => {
		const action: PendingAction = {
			id: "action-2",
			tool: "create-ticket",
			params: { title: "Incident", description: "Details", severity: "high" },
			reason: "Needs tracking",
		};

		const result = await executeAction(action, {
			reportContent: "Full report",
			threadId: "thread-1",
		});

		expect(result.status).toBe("success");
		expect(result.tool).toBe("create-ticket");
		expect(result.actionId).toBe("action-2");
		expect(mockLinearCreateIssue).toHaveBeenCalledTimes(1);
	});

	test("executeAction returns error for unknown tool", async () => {
		const action = {
			id: "action-3",
			tool: "unknown-tool" as "notify-slack",
			params: {},
			reason: "test",
		};

		const result = await executeAction(action, {
			reportContent: "",
			threadId: "thread-1",
		});

		expect(result.status).toBe("error");
		expect(result.error).toContain("Unknown action tool");
	});
});

// SIO-1635: the pi-coms tools dispatch through the verifier, which refuses
// before touching the network when the hub is not configured.
describe("executor pi-coms dispatch", () => {
	const originalEnv = { ...process.env };
	const originalFetch = globalThis.fetch;

	beforeEach(() => {
		delete process.env.PI_COMS_NET_SERVER_URL;
		delete process.env.PI_COMS_NET_AUTH_TOKEN;
	});

	afterEach(() => {
		process.env = { ...originalEnv };
		globalThis.fetch = originalFetch;
	});

	test("verify-with-pi reports the unconfigured hub as an action error", async () => {
		const action: PendingAction = { id: "a-pi-1", tool: "verify-with-pi", params: { estate: "e" }, reason: "r" };
		const result = await executeAction(action, { reportContent: "report", threadId: "t" });
		expect(result).toEqual({
			actionId: "a-pi-1",
			tool: "verify-with-pi",
			status: "error",
			error: "pi-coms hub is not configured",
		});
	});

	test("investigate-with-pi reports the unconfigured hub as an action error", async () => {
		const action: PendingAction = {
			id: "a-pi-2",
			tool: "investigate-with-pi",
			params: { estate: "e", focus: ["q"] },
			reason: "r",
		};
		const result = await executeAction(action, { reportContent: "report", threadId: "t" });
		expect(result.status).toBe("error");
		expect(result.error).toBe("pi-coms hub is not configured");
	});

	test("verify-with-pi maps a hub verdict and follow-up onto the ActionResult", async () => {
		process.env.PI_COMS_NET_SERVER_URL = "http://hub.test";
		process.env.PI_COMS_NET_AUTH_TOKEN = "tok";
		const verdict = {
			verdict: "partially_confirmed",
			summary: "s",
			claims: [{ claim: "c", status: "unverifiable", evidence: "e" }],
		};
		globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
			const path = String(input).replace("http://hub.test", "");
			const json = (b: unknown) => new Response(JSON.stringify(b), { headers: { "content-type": "application/json" } });
			if (path === "/v1/agents/register") return json({ ok: true, agent: { name: "incident-analyzer" } });
			if (path.startsWith("/v1/agents?")) return json({ agents: [{ session_id: "s", name: "est", status: "online" }] });
			if (path === "/v1/messages") return json({ ok: true, msg_id: "m1", status: "delivered", target_session: "t" });
			if (path.startsWith("/v1/messages/m1/await"))
				return json({ msg_id: "m1", status: "complete", response: verdict, error: null });
			if (init?.method === "DELETE") return json({ ok: true });
			return json({ ok: true });
		}) as typeof fetch;
		const action: PendingAction = { id: "a-pi-3", tool: "verify-with-pi", params: { estate: "est" }, reason: "r" };
		const result = await executeAction(action, { reportContent: "report", threadId: "t" });
		expect(result.status).toBe("success");
		expect(result.result?.kind).toBe("verdict");
		expect(result.followUpActions?.[0]?.tool).toBe("investigate-with-pi");
	});
});

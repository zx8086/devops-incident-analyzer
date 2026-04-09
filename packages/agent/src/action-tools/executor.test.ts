// agent/src/action-tools/executor.test.ts
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { PendingAction } from "@devops-agent/shared";
import { executeAction, getAvailableActionTools } from "./executor.ts";

mock.module("./slack-notifier.ts", () => ({
	isSlackConfigured: () => !!process.env.SLACK_BOT_TOKEN,
	executeSlackNotify: mock(() =>
		Promise.resolve({ sent: true, timestamp: "123.456", channel: "C123" }),
	),
	getSeverityColor: () => "#E01E5A",
}));

mock.module("./ticket-creator.ts", () => ({
	isLinearConfigured: () => !!process.env.LINEAR_API_KEY,
	executeCreateTicket: mock(() =>
		Promise.resolve({ ticket_id: "INC-1", url: "https://linear.app/issue/INC-1" }),
	),
	severityToPriority: () => 1,
	buildTicketDescription: () => "desc",
}));

describe("executor", () => {
	const originalEnv = { ...process.env };

	beforeEach(() => {
		process.env.SLACK_BOT_TOKEN = "xoxb-test";
		process.env.SLACK_DEFAULT_CHANNEL = "#test";
		process.env.LINEAR_API_KEY = "lin_api_test";
		process.env.LINEAR_TEAM_ID = "team-id";
		process.env.LINEAR_PROJECT_ID = "project-id";
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

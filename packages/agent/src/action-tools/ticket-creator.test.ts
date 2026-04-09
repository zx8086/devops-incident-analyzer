// agent/src/action-tools/ticket-creator.test.ts
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
	buildTicketDescription,
	executeCreateTicket,
	isLinearConfigured,
	severityToPriority,
} from "./ticket-creator.ts";

const mockCreateIssue = mock(() =>
	Promise.resolve({
		success: true,
		issue: Promise.resolve({
			id: "ISSUE-123",
			identifier: "INC-42",
			url: "https://linear.app/team/issue/INC-42",
		}),
	}),
);

const mockCreateAttachment = mock(() => Promise.resolve({ success: true }));

mock.module("@linear/sdk", () => ({
	LinearClient: class {
		createIssue = mockCreateIssue;
		createAttachment = mockCreateAttachment;
	},
}));

describe("ticket-creator", () => {
	const originalEnv = { ...process.env };

	beforeEach(() => {
		process.env.LINEAR_API_KEY = "lin_api_test_key";
		process.env.LINEAR_TEAM_ID = "team-uuid-123";
		process.env.LINEAR_PROJECT_ID = "project-uuid-456";
		mockCreateIssue.mockClear();
		mockCreateAttachment.mockClear();
	});

	afterEach(() => {
		process.env = { ...originalEnv };
	});

	test("isLinearConfigured returns true when env vars set", () => {
		expect(isLinearConfigured()).toBe(true);
	});

	test("isLinearConfigured returns false when LINEAR_API_KEY missing", () => {
		delete process.env.LINEAR_API_KEY;
		expect(isLinearConfigured()).toBe(false);
	});

	test("severityToPriority maps correctly", () => {
		expect(severityToPriority("critical")).toBe(1);
		expect(severityToPriority("high")).toBe(2);
		expect(severityToPriority("medium")).toBe(3);
		expect(severityToPriority("low")).toBe(4);
		expect(severityToPriority("unknown")).toBe(3);
	});

	test("buildTicketDescription formats with all fields", () => {
		const desc = buildTicketDescription({
			description: "Service is returning 503 errors",
			affected_services: ["api-gateway", "auth-service"],
			datasources_queried: ["elastic", "kafka"],
		});

		expect(desc).toContain("Service is returning 503 errors");
		expect(desc).toContain("api-gateway");
		expect(desc).toContain("auth-service");
		expect(desc).toContain("elastic");
		expect(desc).toContain("kafka");
	});

	test("buildTicketDescription handles missing optional fields", () => {
		const desc = buildTicketDescription({
			description: "Simple incident",
		});

		expect(desc).toContain("Simple incident");
		expect(desc).not.toContain("Affected Services");
		expect(desc).not.toContain("Datasources Analyzed");
	});

	test("creates ticket with correct priority mapping", async () => {
		const result = await executeCreateTicket({
			title: "High CPU on api-gateway",
			description: "API gateway pods showing 95% CPU",
			severity: "critical",
		});

		expect(result.ticket_id).toBe("INC-42");
		expect(result.url).toBe("https://linear.app/team/issue/INC-42");
		expect(mockCreateIssue).toHaveBeenCalledTimes(1);

		const callArgs = (mockCreateIssue.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
		expect(callArgs.priority).toBe(1);
		expect(callArgs.title).toBe("High CPU on api-gateway");
	});

	test("attaches full report when reportContent provided", async () => {
		await executeCreateTicket({
			title: "Test incident",
			description: "Test description",
			severity: "medium",
			reportContent: "Full markdown report here",
		});

		expect(mockCreateIssue).toHaveBeenCalledTimes(1);
		expect(mockCreateAttachment).toHaveBeenCalledTimes(1);
	});

	test("returns error result when Linear API fails", async () => {
		mockCreateIssue.mockImplementationOnce(() => Promise.reject(new Error("auth_failed")));

		const result = await executeCreateTicket({
			title: "Test",
			description: "Test",
			severity: "low",
		});

		expect(result.ticket_id).toBe("");
		expect(result.url).toBe("");
	});
});

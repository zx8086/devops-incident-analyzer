// agent/src/action-tools/slack-notifier.test.ts
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { executeSlackNotify, getSeverityColor, isSlackConfigured } from "./slack-notifier.ts";

// Mock @slack/web-api
const mockPostMessage = mock(() =>
	Promise.resolve({ ok: true, ts: "1234567890.123456", channel: "C12345" }),
);
const mockFilesUpload = mock(() => Promise.resolve({ ok: true }));

mock.module("@slack/web-api", () => ({
	WebClient: class {
		chat = { postMessage: mockPostMessage };
		files = { uploadV2: mockFilesUpload };
	},
}));

describe("slack-notifier", () => {
	const originalEnv = { ...process.env };

	beforeEach(() => {
		process.env.SLACK_BOT_TOKEN = "xoxb-test-token";
		process.env.SLACK_DEFAULT_CHANNEL = "#test-incidents";
		mockPostMessage.mockClear();
		mockFilesUpload.mockClear();
	});

	afterEach(() => {
		process.env = { ...originalEnv };
	});

	test("isSlackConfigured returns true when env vars set", () => {
		expect(isSlackConfigured()).toBe(true);
	});

	test("isSlackConfigured returns false when SLACK_BOT_TOKEN missing", () => {
		delete process.env.SLACK_BOT_TOKEN;
		expect(isSlackConfigured()).toBe(false);
	});

	test("getSeverityColor maps severity levels", () => {
		expect(getSeverityColor("critical")).toBe("#E01E5A");
		expect(getSeverityColor("high")).toBe("#E87722");
		expect(getSeverityColor("medium")).toBe("#ECB22E");
		expect(getSeverityColor("low")).toBe("#2EB67D");
		expect(getSeverityColor("info")).toBe("#36C5F0");
	});

	test("sends message to specified channel with severity formatting", async () => {
		const result = await executeSlackNotify({
			channel: "#critical-alerts",
			message: "Service degradation detected",
			severity: "critical",
		});

		expect(result.sent).toBe(true);
		expect(result.timestamp).toBe("1234567890.123456");
		expect(result.channel).toBe("C12345");
		expect(mockPostMessage).toHaveBeenCalledTimes(1);

		const callArgs = (mockPostMessage.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
		expect(callArgs.channel).toBe("#critical-alerts");
		expect(callArgs.text).toContain("Service degradation detected");
	});

	test("falls back to default channel when channel is empty", async () => {
		await executeSlackNotify({
			channel: "",
			message: "Test",
			severity: "info",
		});

		const callArgs = (mockPostMessage.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
		expect(callArgs.channel).toBe("#test-incidents");
	});

	test("includes thread_ts when provided", async () => {
		await executeSlackNotify({
			channel: "#alerts",
			message: "Update",
			severity: "medium",
			thread_ts: "1234567890.000000",
		});

		const callArgs = (mockPostMessage.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
		expect(callArgs.thread_ts).toBe("1234567890.000000");
	});

	test("uploads report as file when reportContent provided", async () => {
		await executeSlackNotify({
			channel: "#alerts",
			message: "Summary",
			severity: "high",
			reportContent: "Full incident report here",
		});

		expect(mockPostMessage).toHaveBeenCalledTimes(1);
		expect(mockFilesUpload).toHaveBeenCalledTimes(1);
	});

	test("returns error result when Slack API fails", async () => {
		mockPostMessage.mockImplementationOnce(() => Promise.reject(new Error("channel_not_found")));

		const result = await executeSlackNotify({
			channel: "#nonexistent",
			message: "Test",
			severity: "info",
		});

		expect(result.sent).toBe(false);
		expect(result.timestamp).toBe("");
		expect(result.channel).toBe("");
	});
});

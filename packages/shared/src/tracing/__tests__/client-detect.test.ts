// shared/src/tracing/__tests__/client-detect.test.ts
import { describe, expect, test } from "bun:test";
import { detectClient, generateSessionId } from "../client-detect.ts";

describe("Client Detection", () => {
	test("detects Claude Desktop for stdio", () => {
		const client = detectClient("stdio");
		expect(client.name).toBe("Claude Desktop");
		expect(client.platform).toBeDefined();
	});

	test("detects n8n from user agent", () => {
		const client = detectClient("http", "n8n/1.0");
		expect(client.name).toBe("n8n");
	});

	test("detects Chrome from user agent", () => {
		const client = detectClient("http", "Mozilla/5.0 Chrome/120");
		expect(client.name).toBe("Chrome Browser");
	});

	test("detects Safari from user agent", () => {
		const client = detectClient("http", "Mozilla/5.0 Safari/605");
		expect(client.name).toBe("Safari Browser");
	});

	test("defaults to Web Client for http without user agent", () => {
		const client = detectClient("http");
		expect(client.name).toBe("Web Client");
		expect(client.platform).toBe("web");
	});
});

describe("Session ID Generation", () => {
	test("generates unique IDs", () => {
		const id1 = generateSessionId("conn-1", { name: "Test" });
		const id2 = generateSessionId("conn-1", { name: "Test" });
		expect(id1).not.toBe(id2);
	});

	test("includes client name prefix", () => {
		const id = generateSessionId("conn-1", { name: "Claude Desktop" });
		expect(id).toMatch(/^claude-desktop-/);
	});

	test("uses 'unknown' prefix without client info", () => {
		const id = generateSessionId("conn-1");
		expect(id).toMatch(/^unknown-/);
	});
});

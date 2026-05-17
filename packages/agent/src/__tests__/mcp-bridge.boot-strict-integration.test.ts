import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { _resetExpectedIdentityForTest, createMcpClient, McpRoleMismatchError } from "../mcp-bridge.ts";

// Mock @langchain/mcp-adapters so createMcpClient doesn't try real network.
// MultiServerMCPClient.getTools() returns a single fake tool so the connection
// succeeds and falls through to the boot-strict /identity probe.
mock.module("@langchain/mcp-adapters", () => ({
	MultiServerMCPClient: class {
		async getTools() {
			return [{ name: "fake-tool", description: "stub", invoke: async () => "ok" }];
		}
	},
}));

const originalFetch = global.fetch;
afterEach(() => {
	_resetExpectedIdentityForTest();
	global.fetch = originalFetch;
});

describe("boot-strict identity check", () => {
	beforeEach(() => _resetExpectedIdentityForTest());

	test("throws McpRoleMismatchError when /identity role does not match", async () => {
		global.fetch = mock(async (input: string | URL | Request) => {
			const url = typeof input === "string" ? input : input.toString();
			if (url.endsWith("/identity")) {
				return Response.json({
					instanceId: "x",
					role: "elastic-mcp",
					version: "0.0.0",
					bootedAt: "2026-05-17T00:00:00.000Z",
					pid: 1,
					mode: "http",
					upstreamFingerprint: "abc",
				});
			}
			return new Response("ok");
		}) as unknown as typeof fetch;

		await expect(createMcpClient({ konnectUrl: "http://localhost:9083" })).rejects.toBeInstanceOf(McpRoleMismatchError);
	});

	test("accepts identity card when role matches", async () => {
		global.fetch = mock(async (input: string | URL | Request) => {
			const url = typeof input === "string" ? input : input.toString();
			if (url.endsWith("/identity")) {
				return Response.json({
					instanceId: "x",
					role: "konnect-mcp",
					version: "0.0.0",
					bootedAt: "2026-05-17T00:00:00.000Z",
					pid: 1,
					mode: "http",
					upstreamFingerprint: "abc",
				});
			}
			return new Response("ok");
		}) as unknown as typeof fetch;

		await createMcpClient({ konnectUrl: "http://localhost:9083" });
	});
});

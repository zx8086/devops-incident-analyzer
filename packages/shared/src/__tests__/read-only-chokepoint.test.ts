// shared/src/__tests__/read-only-chokepoint.test.ts
import { describe, expect, test } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { installReadOnlyChokepoint, type ReadOnlyManagerLike } from "../read-only-chokepoint.ts";

// Builds a minimal McpServer that registers a tool whose handler records every
// call. The chokepoint should sit between the dispatcher and this handler.
function buildServerWithSpyTool(toolName: string) {
	const server = new McpServer(
		{ name: "chokepoint-test", version: "0.0.0" },
		{ capabilities: { tools: { listChanged: true } } as Record<string, unknown> },
	);
	const calls: Array<{ args: unknown }> = [];
	server.registerTool(toolName, { description: "spy tool", inputSchema: z.object({}).shape }, async (args) => {
		calls.push({ args });
		return { content: [{ type: "text", text: "ok" }] };
	});
	return { server, calls };
}

// Reaches through to the underlying Server's "tools/call" handler so a test
// can simulate dispatch without standing up a transport. Mirrors the entry
// the chokepoint replaces.
function dispatchToolsCall(server: McpServer, toolName: string): Promise<unknown> {
	const internal = (
		server as unknown as {
			server: { _requestHandlers: Map<string, (req: unknown, extra: unknown) => Promise<unknown>> };
		}
	).server;
	const handler = internal._requestHandlers.get("tools/call");
	if (!handler) throw new Error("tools/call handler missing -- chokepoint setup is wrong");
	return handler({ method: "tools/call", params: { name: toolName, arguments: {} } }, { signal: undefined as never });
}

describe("installReadOnlyChokepoint", () => {
	test("blocks dispatch when manager returns allowed=false (strict mode)", async () => {
		const { server, calls } = buildServerWithSpyTool("destructive_tool");
		const blocked = { content: [{ type: "text", text: "READ-ONLY MODE: blocked" }] };
		const manager: ReadOnlyManagerLike = {
			checkOperation: () => ({ allowed: false, error: "blocked by test" }),
			createBlockedResponse: () => blocked,
			createWarningResponse: (_n, r) => r,
		};

		installReadOnlyChokepoint(server, manager);
		const result = await dispatchToolsCall(server, "destructive_tool");

		expect(result).toBe(blocked);
		expect(calls).toHaveLength(0);
	});

	test("attaches warning when manager returns allowed=true with warning (non-strict mode)", async () => {
		const { server, calls } = buildServerWithSpyTool("warned_tool");
		const warned = {
			content: [
				{ type: "text", text: "WARN" },
				{ type: "text", text: "ok" },
			],
		};
		let warningInputs: { name: string; original: unknown } | undefined;
		const manager: ReadOnlyManagerLike = {
			checkOperation: () => ({ allowed: true, warning: "be careful" }),
			createBlockedResponse: () => ({ content: [] }),
			createWarningResponse: (name, original) => {
				warningInputs = { name, original };
				return warned;
			},
		};

		installReadOnlyChokepoint(server, manager);
		const result = await dispatchToolsCall(server, "warned_tool");

		expect(calls).toHaveLength(1);
		expect(warningInputs?.name).toBe("warned_tool");
		expect(result).toBe(warned);
	});

	test("passes through unchanged when manager returns allowed=true without warning", async () => {
		const { server, calls } = buildServerWithSpyTool("read_tool");
		const manager: ReadOnlyManagerLike = {
			checkOperation: () => ({ allowed: true }),
			createBlockedResponse: () => ({ content: [] }),
			createWarningResponse: (_n, r) => r,
		};

		installReadOnlyChokepoint(server, manager);
		const result = (await dispatchToolsCall(server, "read_tool")) as { content: Array<{ text: string }> };

		expect(calls).toHaveLength(1);
		expect(result.content[0]?.text).toBe("ok");
	});

	test("throws if installed before any tool is registered", () => {
		const server = new McpServer(
			{ name: "no-tools", version: "0.0.0" },
			{ capabilities: { tools: { listChanged: true } } as Record<string, unknown> },
		);
		const manager: ReadOnlyManagerLike = {
			checkOperation: () => ({ allowed: true }),
			createBlockedResponse: () => ({ content: [] }),
			createWarningResponse: (_n, r) => r,
		};

		expect(() => installReadOnlyChokepoint(server, manager)).toThrow(/no 'tools\/call' handler/);
	});
});

// shared/src/__tests__/tool-call-logging.test.ts
import { describe, expect, test } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { installReadOnlyChokepoint, type ReadOnlyManagerLike } from "../read-only-chokepoint.ts";
import { installToolCallLogging, type ToolCallLogger } from "../tool-call-logging.ts";

type ToolResult = { content: Array<{ type: "text"; text: string }> };

function buildServerWithTool(toolName: string, handler: () => Promise<ToolResult>) {
	const server = new McpServer(
		{ name: "log-test", version: "0.0.0" },
		{ capabilities: { tools: { listChanged: true } } as Record<string, unknown> },
	);
	server.registerTool(toolName, { description: "tool", inputSchema: z.object({}).shape }, handler);
	return server;
}

function dispatchToolsCall(server: McpServer, toolName: string): Promise<unknown> {
	const internal = (
		server as unknown as {
			server: { _requestHandlers: Map<string, (req: unknown, extra: unknown) => Promise<unknown>> };
		}
	).server;
	const handler = internal._requestHandlers.get("tools/call");
	if (!handler) throw new Error("tools/call handler missing");
	return handler({ method: "tools/call", params: { name: toolName, arguments: {} } }, { signal: undefined as never });
}

function recordingLogger() {
	const lines: Array<{ level: string; message: string; meta?: Record<string, unknown> }> = [];
	const logger: ToolCallLogger = {
		debug: (message, meta) => lines.push({ level: "debug", message, meta }),
		info: (message, meta) => lines.push({ level: "info", message, meta }),
		warn: (message, meta) => lines.push({ level: "warn", message, meta }),
	};
	return { logger, lines };
}

describe("installToolCallLogging", () => {
	test("logs start + ok with the tool name and duration; preserves the result", async () => {
		const server = buildServerWithTool("read_thing", async () => ({ content: [{ type: "text", text: "ok" }] }));
		const { logger, lines } = recordingLogger();
		// monotonic injected clock: 1000 (start) then 1042 (end) -> durationMs 42
		const ticks = [1000, 1042];
		let i = 0;
		installToolCallLogging(server, logger, () => ticks[Math.min(i++, ticks.length - 1)] as number);

		const result = await dispatchToolsCall(server, "read_thing");
		expect(result).toEqual({ content: [{ type: "text", text: "ok" }] });

		expect(lines.find((l) => l.message === "tools/call start")?.meta?.tool).toBe("read_thing");
		const ok = lines.find((l) => l.message === "tools/call ok");
		expect(ok?.level).toBe("info");
		expect(ok?.meta?.tool).toBe("read_thing");
		expect(ok?.meta?.durationMs).toBe(42);
	});

	// The MCP SDK normalises a throwing tool handler into a resolved isError:true result
	// (not a rejection), so the wrap detects it via the result, not a catch.
	test("logs an error line when the tool handler fails (SDK returns isError:true)", async () => {
		const server = buildServerWithTool("boom", async () => {
			throw new Error("kaboom");
		});
		const { logger, lines } = recordingLogger();
		installToolCallLogging(server, logger, () => 0);

		const result = (await dispatchToolsCall(server, "boom")) as { isError?: boolean };
		expect(result.isError).toBe(true);
		const err = lines.find((l) => l.message === "tools/call error");
		expect(err?.level).toBe("warn");
		expect(err?.meta?.tool).toBe("boom");
		expect(lines.find((l) => l.message === "tools/call ok")).toBeUndefined();
	});

	test("composes with the read-only chokepoint: a blocked call is still logged", async () => {
		const server = buildServerWithTool("destructive", async () => ({ content: [{ type: "text", text: "ran" }] }));
		const blocked = { content: [{ type: "text", text: "READ-ONLY: blocked" }] };
		const manager: ReadOnlyManagerLike = {
			checkOperation: () => ({ allowed: false, error: "blocked" }),
			createBlockedResponse: () => blocked,
			createWarningResponse: (_n, r) => r,
		};
		const { logger, lines } = recordingLogger();
		// same order as createMcpApplication: read-only INNER, logging OUTER
		installReadOnlyChokepoint(server, manager);
		installToolCallLogging(server, logger, () => 0);

		const result = await dispatchToolsCall(server, "destructive");
		expect(result).toBe(blocked); // enforcement still wins
		expect(lines.find((l) => l.message === "tools/call ok")?.meta?.tool).toBe("destructive"); // and it logged
	});

	test("throws if no tools/call handler is registered (must run after tool registration)", () => {
		const bare = new McpServer({ name: "bare", version: "0.0.0" }, { capabilities: {} });
		const { logger } = recordingLogger();
		expect(() => installToolCallLogging(bare, logger)).toThrow(/no 'tools\/call' handler/);
	});
});

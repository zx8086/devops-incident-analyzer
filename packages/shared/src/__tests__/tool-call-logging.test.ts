// shared/src/__tests__/tool-call-logging.test.ts
import { describe, expect, test } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { installReadOnlyChokepoint, type ReadOnlyManagerLike } from "../read-only-chokepoint.ts";
import { installToolCallLogging, type ToolCallLogger, type ToolCallOutcome } from "../tool-call-logging.ts";
import { buildToolErrorEnvelope } from "../tool-error.ts";

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

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

	// SIO-1400: optional onCall sink feeding the SQLite usage counters.
	test("onCall sink receives ok:true on success and ok:false on an isError result", async () => {
		const okServer = buildServerWithTool("read_thing", async () => ({ content: [{ type: "text", text: "ok" }] }));
		const failServer = buildServerWithTool("boom", async () => {
			throw new Error("kaboom");
		});
		const outcomes: ToolCallOutcome[] = [];
		const { logger } = recordingLogger();
		const ticks = [1000, 1042];
		let i = 0;
		installToolCallLogging(
			okServer,
			logger,
			() => ticks[Math.min(i++, ticks.length - 1)] as number,
			(o) => outcomes.push(o),
		);
		installToolCallLogging(
			failServer,
			logger,
			() => 0,
			(o) => outcomes.push(o),
		);

		await dispatchToolsCall(okServer, "read_thing");
		await dispatchToolsCall(failServer, "boom");

		expect(outcomes).toEqual([
			{ tool: "read_thing", ok: true, durationMs: 42 },
			// SIO-1402: a thrown handler surfaces as prose text (no envelope) -> unstructured
			{ tool: "boom", ok: false, durationMs: 0, failureClass: "unstructured" },
		]);
	});

	// SIO-1402: a returned { _error } envelope with a bad-input rule match classifies
	// bad-input on the outcome (same vocabulary as the eval's tool_arg_validity).
	test("onCall sink classifies an envelope error result as bad-input", async () => {
		const envelopeText = JSON.stringify(buildToolErrorEnvelope({ kind: "bad-query", message: "malformed DSL" }));
		const server = buildServerWithTool("query_thing", async () => ({
			content: [{ type: "text", text: envelopeText }],
			isError: true,
		}));
		const outcomes: ToolCallOutcome[] = [];
		const { logger } = recordingLogger();
		installToolCallLogging(
			server,
			logger,
			() => 0,
			(o) => outcomes.push(o),
		);

		await dispatchToolsCall(server, "query_thing");

		expect(outcomes).toHaveLength(1);
		expect(outcomes[0]?.ok).toBe(false);
		expect(outcomes[0]?.failureClass).toBe("bad-input");
	});

	// SIO-1402: measured SDK behavior -- an unknown tool name does NOT reject at
	// dispatch; it RESOLVES to isError:true with "MCP error -32602: Tool <name>
	// not found" text, so the classifier catches it on the isError branch.
	test("onCall sink classifies an unknown tool name as unknown-tool", async () => {
		const server = buildServerWithTool("real_tool", async () => ({ content: [{ type: "text", text: "ok" }] }));
		const outcomes: ToolCallOutcome[] = [];
		const { logger } = recordingLogger();
		installToolCallLogging(
			server,
			logger,
			() => 0,
			(o) => outcomes.push(o),
		);

		const result = (await dispatchToolsCall(server, "no_such_tool")) as { isError?: boolean };
		expect(result.isError).toBe(true);
		expect(outcomes).toEqual([{ tool: "no_such_tool", ok: false, durationMs: 0, failureClass: "unknown-tool" }]);
	});

	test("a throwing onCall sink neither breaks the dispatch result nor suppresses the log line", async () => {
		const server = buildServerWithTool("read_thing", async () => ({ content: [{ type: "text", text: "ok" }] }));
		const { logger, lines } = recordingLogger();
		installToolCallLogging(
			server,
			logger,
			() => 0,
			() => {
				throw new Error("sink exploded");
			},
		);

		const result = await dispatchToolsCall(server, "read_thing");
		expect(result).toEqual({ content: [{ type: "text", text: "ok" }] });
		expect(lines.find((l) => l.message === "tools/call ok")?.meta?.tool).toBe("read_thing");
		const sinkWarn = lines.find((l) => l.message === "tools/call outcome sink failed");
		expect(sinkWarn?.meta?.error).toBe("sink exploded");
	});
});

// shared/src/tool-call-logging.ts
// SIO-974: universal tools/call lifecycle logging for every MCP server produced by
// createMcpApplication. The shared bootstrap previously logged only startup/shutdown, and
// the read-only chokepoint (read-only-chokepoint.ts) wrapped tools/call for ENFORCEMENT but
// emitted nothing -- so servers whose tool handlers didn't log themselves (knowledge-graph,
// elastic-iac's non-gitlab tools) were invisible at the MCP layer. This wraps the same
// tools/call dispatch handler to emit a structured per-call lifecycle line, independent of
// the read-only manager, for ALL servers.
//
// PII-safe: logs the tool name + timing + ok flag ONLY -- never args or results.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export interface ToolCallLogger {
	debug?(message: string, meta?: Record<string, unknown>): void;
	info(message: string, meta?: Record<string, unknown>): void;
	warn(message: string, meta?: Record<string, unknown>): void;
}

const TOOLS_CALL_METHOD = "tools/call";

type RequestHandler = (request: unknown, extra: unknown) => Promise<unknown>;

interface InternalServerHandlers {
	_requestHandlers: Map<string, RequestHandler>;
}

// A CallToolResult with isError:true (the SDK's normalised form of a thrown tool handler).
function isErrorResult(result: unknown): boolean {
	return typeof result === "object" && result !== null && (result as { isError?: unknown }).isError === true;
}

function extractToolName(request: unknown): string | undefined {
	if (typeof request !== "object" || request === null) return undefined;
	const params = (request as { params?: unknown }).params;
	if (typeof params !== "object" || params === null) return undefined;
	const name = (params as { name?: unknown }).name;
	return typeof name === "string" ? name : undefined;
}

// Wraps the McpServer's underlying "tools/call" handler with start/end lifecycle logging.
// Must run AFTER tool registration (the handler must exist). Composes with the read-only
// chokepoint: install logging OUTERMOST (after read-only) so a blocked call still logs --
// see createMcpApplication for the ordering. A `now` injection point keeps the wrap testable
// without the Date.now() ban in some environments.
export function installToolCallLogging(
	server: McpServer,
	logger: ToolCallLogger,
	now: () => number = () => Date.now(),
): void {
	const internal = server.server as unknown as InternalServerHandlers;
	const handlers = internal._requestHandlers;
	if (!handlers || typeof handlers.get !== "function") {
		throw new Error("Cannot install tool-call logging: McpServer internals are not as expected.");
	}
	const original = handlers.get(TOOLS_CALL_METHOD);
	if (!original) {
		throw new Error(
			"Cannot install tool-call logging: no 'tools/call' handler registered. Ensure tools are registered before createMcpApplication wraps the factory.",
		);
	}

	const wrapped: RequestHandler = async (request, extra) => {
		const tool = extractToolName(request) ?? "unknown";
		const start = now();
		logger.debug?.("tools/call start", { tool });
		try {
			const result = await original(request, extra);
			// The MCP SDK normalises a throwing tool handler into a result with isError:true
			// rather than re-throwing, so a tool-level failure arrives here as a RESOLVED
			// error response, not an exception. Surface it as a warning. (The catch below
			// only fires on a dispatch-level failure, which is rare.)
			const durationMs = now() - start;
			if (isErrorResult(result)) {
				logger.warn("tools/call error", { tool, durationMs });
			} else {
				logger.info("tools/call ok", { tool, durationMs });
			}
			return result;
		} catch (error) {
			logger.warn("tools/call dispatch error", {
				tool,
				durationMs: now() - start,
				error: error instanceof Error ? error.message : String(error),
			});
			throw error;
		}
	};

	handlers.set(TOOLS_CALL_METHOD, wrapped);
}

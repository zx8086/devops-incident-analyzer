// shared/src/read-only-chokepoint.ts
// SIO-671: dispatcher-level chokepoint for MCP read-only enforcement.
// Replaces per-tool decorators by wrapping the underlying Server's
// "tools/call" request handler once, after the consumer factory has
// finished registering tools.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export interface ReadOnlyCheck {
	allowed: boolean;
	warning?: string;
	error?: string;
}

// Structural interface so consumers can supply their own manager without
// pulling shared into the elastic package's type graph (or vice versa).
// Method signatures match ReadOnlyModeManager in mcp-server-elastic but
// are widened to unknown so the chokepoint just passes results through.
export interface ReadOnlyManagerLike {
	checkOperation(toolName: string): ReadOnlyCheck;
	createBlockedResponse(toolName: string): unknown;
	createWarningResponse(toolName: string, originalResponse: unknown): unknown;
}

export interface ReadOnlyMiddlewareConfig {
	manager: ReadOnlyManagerLike;
}

// MCP SDK key for the tool dispatch handler. Sourced from
// CallToolRequestSchema.method in @modelcontextprotocol/sdk types -- a
// string literal, not derived from runtime schema introspection so the
// chokepoint stays stable across SDK refactors.
const TOOLS_CALL_METHOD = "tools/call";

type RequestHandler = (request: unknown, extra: unknown) => Promise<unknown>;

interface InternalServerHandlers {
	_requestHandlers: Map<string, RequestHandler>;
}

// Replaces the existing "tools/call" handler on the McpServer's underlying
// Server with one that consults the read-only manager before delegating.
// Must be called AFTER tool registration so the original handler exists.
export function installReadOnlyChokepoint(server: McpServer, manager: ReadOnlyManagerLike): void {
	const internal = server.server as unknown as InternalServerHandlers;
	const handlers = internal._requestHandlers;
	if (!handlers || typeof handlers.get !== "function") {
		throw new Error("Cannot install read-only chokepoint: McpServer internals are not as expected.");
	}
	const original = handlers.get(TOOLS_CALL_METHOD);
	if (!original) {
		// No tools registered yet -- nothing to wrap. The consumer factory must
		// register at least one tool before returning, otherwise read-only
		// enforcement cannot be installed at the dispatcher level.
		throw new Error(
			"Cannot install read-only chokepoint: no 'tools/call' handler registered. Ensure tools are registered before createMcpApplication wraps the factory.",
		);
	}

	const wrapped: RequestHandler = async (request, extra) => {
		const toolName = extractToolName(request);
		if (typeof toolName !== "string") {
			return original(request, extra);
		}
		const check = manager.checkOperation(toolName);
		if (!check.allowed) {
			return manager.createBlockedResponse(toolName);
		}
		const result = await original(request, extra);
		if (check.warning) {
			return manager.createWarningResponse(toolName, result);
		}
		return result;
	};

	handlers.set(TOOLS_CALL_METHOD, wrapped);
}

function extractToolName(request: unknown): unknown {
	if (typeof request !== "object" || request === null) return undefined;
	const params = (request as { params?: unknown }).params;
	if (typeof params !== "object" || params === null) return undefined;
	return (params as { name?: unknown }).name;
}

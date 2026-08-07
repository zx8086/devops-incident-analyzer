// src/v2/tool-call-wrappers.ts
//
// SIO-1424: v2 rebuild of packages/shared/src/read-only-chokepoint.ts and
// packages/shared/src/tool-call-logging.ts against the MCP SDK 2.0.0 public seam.
//
// v1's chokepoint/logging both monkey-patch the SDK's PRIVATE `server.server._requestHandlers`
// Map to intercept every tools/call dispatch in ONE wrap (see read-only-chokepoint.ts:43,
// tool-call-logging.ts:115). The SIO-1424 discovery spike confirmed v2 has no equivalent public,
// single-point dispatch hook: `CreateMcpHandlerOptions` and `ServerOptions` were both fully
// enumerated and neither exposes a middleware/interceptor option, and `_requestHandlers` is STILL
// private in v2 (same shape as v1) -- reaching into it would be exactly as unsupported as before.
//
// The one clean PUBLIC seam v2 does expose is per-tool: `RegisteredTool.update({ callback })`
// (confirmed via the runtime bundle: update() reassigns `.handler` and regenerates `.executor`
// via a thin `(args, ctx) => handler(args, ctx)` pass-through). So this file wraps N times (once
// per registered tool) instead of once at dispatch -- a real ergonomic step back from v1, flagged
// explicitly in the SIO-1424 PR. Preserves v1's exact composition order and behavioral contracts:
// read-only-chokepoint wraps INNER, tool-call-logging wraps OUTER (a blocked call is still
// logged), and logging counts terminal outcomes via `result.isError === true` detection.
import type { CallToolResult, InputRequiredResult, RegisteredTool, ServerContext } from "@modelcontextprotocol/server";

type ToolCallback = (args: unknown, ctx: ServerContext) => Promise<CallToolResult | InputRequiredResult>;

// Wraps ONE tool's handler and re-installs it via the public RegisteredTool.update() seam. The
// wrapper receives the tool's own name and its current handler (so composing multiple wrappers --
// read-only then logging -- chains correctly: each call passes the PREVIOUS wrapper's result as
// the next wrapper's inner handler).
function wrapToolHandler(
	tool: RegisteredTool,
	name: string,
	wrap: (inner: ToolCallback, name: string) => ToolCallback,
): void {
	const wrapped = wrap(tool.handler as ToolCallback, name);
	tool.update({ callback: wrapped as never });
}

export interface ReadOnlyCheck {
	allowed: boolean;
	warning?: string;
	error?: string;
}

// Structural interface mirrored from read-only-chokepoint.ts's ReadOnlyManagerLike -- kept
// independent (not imported from @devops-agent/shared) so packages/shared never needs to know
// about v2-specific types, matching the F1/F2 dependency-isolation rule (v2 SDK only in the
// couchbase package.json).
export interface ReadOnlyManagerLike {
	checkOperation(toolName: string): ReadOnlyCheck;
	createBlockedResponse(toolName: string): unknown;
	createWarningResponse(toolName: string, originalResponse: unknown): unknown;
}

// v1 parity: packages/shared/src/read-only-chokepoint.ts's installReadOnlyChokepoint, rebuilt
// against RegisteredTool.update() instead of the private _requestHandlers Map.
export function installReadOnlyChokepointV2(tools: Map<string, RegisteredTool>, manager: ReadOnlyManagerLike): void {
	for (const [name, tool] of tools) {
		wrapToolHandler(tool, name, (inner, toolName) => async (args, ctx) => {
			const check = manager.checkOperation(toolName);
			if (!check.allowed) {
				return manager.createBlockedResponse(toolName) as CallToolResult;
			}
			const result = await inner(args, ctx);
			if (check.warning) {
				return manager.createWarningResponse(toolName, result) as CallToolResult;
			}
			return result;
		});
	}
}

export interface ToolCallLogger {
	debug?(message: string, meta?: Record<string, unknown>): void;
	info(message: string, meta?: Record<string, unknown>): void;
	warn(message: string, meta?: Record<string, unknown>): void;
}

// SIO-1400 parity: outcome shape matches packages/shared/src/tool-call-logging.ts's
// ToolCallOutcome exactly, so a future shared-metrics consumer needs no v1/v2 branching.
export interface ToolCallOutcome {
	tool: string;
	ok: boolean;
	durationMs: number;
}

function isErrorResult(result: unknown): boolean {
	return typeof result === "object" && result !== null && (result as { isError?: unknown }).isError === true;
}

// v1 parity: packages/shared/src/tool-call-logging.ts's installToolCallLogging, rebuilt against
// RegisteredTool.update(). Composition order preserved by the CALLER: install read-only first
// (installReadOnlyChokepointV2), then this -- each wrapToolHandler call wraps the tool's CURRENT
// handler, so calling logging second makes it the outer wrap (mirrors v1's "read-only INNER,
// logging OUTER" ordering, verified in bootstrap.ts's serverFactory closure).
export function installToolCallLoggingV2(
	tools: Map<string, RegisteredTool>,
	logger: ToolCallLogger,
	now: () => number = () => Date.now(),
	onCall?: (outcome: ToolCallOutcome) => void,
): void {
	for (const [name, tool] of tools) {
		wrapToolHandler(tool, name, (inner, toolName) => async (args, ctx) => {
			const start = now();
			logger.debug?.("tools/call start", { tool: toolName });
			try {
				const result = await inner(args, ctx);
				const durationMs = now() - start;
				if (isErrorResult(result)) {
					logger.warn("tools/call error", { tool: toolName, durationMs });
					onCall?.({ tool: toolName, ok: false, durationMs });
				} else {
					logger.info("tools/call ok", { tool: toolName, durationMs });
					onCall?.({ tool: toolName, ok: true, durationMs });
				}
				return result;
			} catch (error) {
				const durationMs = now() - start;
				logger.warn("tools/call dispatch error", {
					tool: toolName,
					durationMs,
					error: error instanceof Error ? error.message : String(error),
				});
				onCall?.({ tool: toolName, ok: false, durationMs });
				throw error;
			}
		});
	}
}

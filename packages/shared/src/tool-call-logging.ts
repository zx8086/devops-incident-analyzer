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
// SIO-1407: the wrap additionally stamps a { _error: { kind: "bad-input" } }
// envelope onto argument-validation rejections (see stampArgValidationEnvelope)
// -- the one result mutation it performs, gated on an unambiguous signature.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
	ARG_VALIDATION_TEXT_RE,
	classifyFailureText,
	extractErrorTextFromContent,
	hasStructuredEnvelope,
	TextContentBlockSchema,
	type ToolCallFailureClass,
} from "./tool-call-metrics.ts";
import { buildToolErrorEnvelope } from "./tool-error.ts";

export interface ToolCallLogger {
	debug?(message: string, meta?: Record<string, unknown>): void;
	info(message: string, meta?: Record<string, unknown>): void;
	warn(message: string, meta?: Record<string, unknown>): void;
}

// SIO-1400: per-call outcome handed to the optional onCall sink (metrics counters).
// SIO-1402: failureClass is set only on isError results (classifyFailureText over
// the error text, which also catches the SDK's resolved unknown-tool-name form);
// dispatch-level rejections stay unclassified (plain failure).
export interface ToolCallOutcome {
	tool: string;
	ok: boolean;
	durationMs: number;
	failureClass?: ToolCallFailureClass;
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

// SIO-1402: envelope text extraction lives in the shared Zod-backed parser
// (extractErrorTextFromContent) so this seam and the agentcore proxy validate
// untrusted content blocks identically.
function extractErrorText(result: unknown): string | undefined {
	return extractErrorTextFromContent((result as { content?: unknown }).content);
}

// SIO-1407: argument-validation rejections are the canonical bad-input event,
// but the validation layer emits prose + raw zod issues with NO { _error }
// envelope -- so the agent's structural classifier falls back to regexes and
// lands on unknown. Stamping here (the one seam every server's dispatch passes
// through) appends a real envelope AFTER the original text: the prose + zod
// issues stay intact for the model to fix its arguments, and the agent's
// depth-aware extractEmbeddedErrorObject anchors on "_error" so the interior
// zod braces cannot derail it. SIO-1388 discipline: stamp ONLY the unambiguous
// validation signature and never a text that already carries an envelope --
// anything else is left byte-identical.
function stampArgValidationEnvelope(result: unknown): void {
	try {
		const content = (result as { content?: unknown }).content;
		if (!Array.isArray(content)) return;
		// SIO-1407 (CodeRabbit): blocks are gated by the same Zod schema the
		// classifier uses; mutation targets the ORIGINAL block object (safeParse
		// output is a copy), keyed by the validated text.
		const texts = content.flatMap((block) => {
			const parsed = TextContentBlockSchema.safeParse(block);
			return parsed.success ? [{ block: block as { text: string }, text: parsed.data.text }] : [];
		});
		// SIO-1407 (CodeRabbit): STRUCTURAL envelope check -- a zod issue path for
		// an input field literally named "_error" contains the '"_error"' bytes
		// without any envelope, and must not suppress stamping.
		if (texts.some((c) => hasStructuredEnvelope(c.text))) return;
		const target = texts.find((c) => ARG_VALIDATION_TEXT_RE.test(c.text.trim()));
		if (!target) return;
		const firstLine = target.text.trim().split("\n")[0]?.slice(0, 300) ?? "invalid tool arguments";
		const envelope = buildToolErrorEnvelope({
			kind: "bad-input",
			message: firstLine,
			advice:
				"The tool arguments failed schema validation. Fix the arguments per the issues listed in this message and retry; do not re-issue the call unchanged.",
		});
		target.block.text = `${target.text}\n\n${JSON.stringify(envelope)}`;
	} catch {
		// stamping is best-effort and must never break dispatch
	}
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
	// SIO-1400: optional per-call sink (SQLite usage counters). Invoked on every
	// outcome branch; a throwing sink is contained so it can never break dispatch.
	onCall?: (outcome: ToolCallOutcome) => void,
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

	const emitOutcome = (outcome: ToolCallOutcome): void => {
		if (!onCall) return;
		try {
			onCall(outcome);
		} catch (error) {
			logger.warn("tools/call outcome sink failed", {
				tool: outcome.tool,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	};

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
				// SIO-1407: stamp BEFORE classification so both the counters and the
				// agent see the same structured bad-input envelope.
				stampArgValidationEnvelope(result);
				logger.warn("tools/call error", { tool, durationMs });
				// SIO-1402: classify only on the error path (brace-scan of one text block).
				emitOutcome({ tool, ok: false, durationMs, failureClass: classifyFailureText(extractErrorText(result)) });
			} else {
				logger.info("tools/call ok", { tool, durationMs });
				emitOutcome({ tool, ok: true, durationMs });
			}
			return result;
		} catch (error) {
			const durationMs = now() - start;
			logger.warn("tools/call dispatch error", {
				tool,
				durationMs,
				error: error instanceof Error ? error.message : String(error),
			});
			// SIO-1402: dispatch-level rejections are transport failures, not tool
			// semantics -- unclassified. (An unknown tool name does NOT land here:
			// measured SDK behavior resolves it to an isError result, classified above.)
			emitOutcome({ tool, ok: false, durationMs });
			throw error;
		}
	};

	handlers.set(TOOLS_CALL_METHOD, wrapped);
}

// src/lib/toolErrorInterceptor.ts
// SIO-1388: stamp the shared structured-error envelope on EVERY tool's thrown error, centrally.
//
// Why central: `buildToolErrorEnvelope` reached only core/search.ts (3 call sites out of 157 tool
// files). Every other tool threw a bespoke McpError, so packages/agent's extractStructuredToolError
// -- which REQUIRES a stamped `category` and returns null without one -- fell back to regex and
// classified expected outcomes as "unknown", which is a DEGRADING category. SIO-1159 recorded the
// cost: 10 expected "index not found" errors dragged confidence to 0.59, below the HITL gate.
//
// Why not central ALONE: classifyElasticError needs `err instanceof ResponseError` to read
// meta.body.error.type, but no tool file preserves the raw error -- catch blocks rebuild an McpError
// from `error.message`. A naive central catch would therefore classify everything "unknown" and
// stamp a degrading category on all ~112 tools, making the misclassification look authoritative.
// Hence the layering below, and the never-stamp-unknown rule that makes it safe.

import { buildToolErrorEnvelope, type ToolErrorKind } from "@devops-agent/shared";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { classifyElasticError, classifyElasticErrorFromMessage, esStatusCode } from "./classifyElasticError.js";

// An error already carrying a shared envelope must pass through untouched: re-stamping would nest
// one envelope inside another's message and break the agent-side JSON.parse. Mirrors the substring
// gate in extractStructuredToolError (sub-agent.ts) so the two agree on what "already stamped" means.
function isAlreadyStamped(error: unknown): boolean {
	const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
	return message.includes('"_error"') && message.includes('"kind"');
}

function messageOf(error: unknown): string {
	if (error instanceof Error) return error.message;
	if (typeof error === "string") return error;
	return String(error);
}

// SIO-1388 (Layer 2): several incident-path tools rewrite the ES error into human prose
// ("Index not found: logs-x"), erasing the type name the interceptor classifies on -- measured
// unstamped: get_mappings, get_index_info, count_documents, list_indices. Their per-file error
// factories already carry the classification in a `type` discriminant, so those factories stamp
// the envelope directly from this map instead of relying on text survival. Keys are the local
// factory discriminants shared across those files; unmapped types (e.g. "execution") stay
// unstamped on purpose -- they are not confidently classifiable.
export const ENVELOPE_KIND_BY_TYPE: Readonly<Record<string, ToolErrorKind | undefined>> = {
	index_not_found: "not-found",
	timeout: "timeout",
	validation: "bad-query",
};

// Structured first (lossless), message text only as a fallback. Returns "unknown" when neither
// recognizes the error -- callers MUST NOT stamp in that case.
export function classifyForEnvelope(error: unknown): ToolErrorKind {
	const structural = classifyElasticError(error);
	if (structural !== "unknown") return structural;
	return classifyElasticErrorFromMessage(messageOf(error));
}

// Wraps a tool handler so any thrown error leaves with a shared envelope when-and-only-when it can
// be classified confidently.
export function withStructuredToolError<TArgs, TExtra, TResult>(
	toolName: string,
	handler: (args: TArgs, extra: TExtra) => Promise<TResult>,
): (args: TArgs, extra: TExtra) => Promise<TResult> {
	return async (args, extra) => {
		try {
			return await handler(args, extra);
		} catch (error) {
			// Already-stamped errors (core/search.ts) keep their hand-written advice, which is richer
			// than anything this generic path could add.
			if (isAlreadyStamped(error)) throw error;

			const kind = classifyForEnvelope(error);

			// THE safety property: an unclassifiable error is rethrown UNCHANGED, so it follows exactly
			// today's path. Stamping "unknown" here would be strictly worse than not stamping -- it
			// maps to a degrading category and would satisfy the agent's category gate, suppressing
			// the existing regex fallback and asserting a confident-looking wrong answer. Worst case
			// for this interceptor is therefore status quo, never a NEW misclassification.
			if (kind === "unknown") throw error;

			const envelope = buildToolErrorEnvelope({
				kind,
				message: `[${toolName}] ${messageOf(error)}`,
				statusCode: esStatusCode(error),
			});
			// Throw (not return): sub-agent.ts recovers envelopes from both thrown McpErrors and
			// success-riding content, and core/search.ts already proves the thrown path in production.
			throw new McpError(ErrorCode.InvalidParams, JSON.stringify(envelope), { toolName });
		}
	};
}

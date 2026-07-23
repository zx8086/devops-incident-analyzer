// src/tools/error-envelope.ts

import {
	buildToolErrorEnvelope,
	mapHttpStatusToKind,
	type StructuredToolError,
	type ToolErrorKind,
} from "@devops-agent/shared";
import { AtlassianAuthRequiredError, AtlassianUpstreamError } from "./custom/parse-atlassian-content.js";

// SIO-1183: atlassian adoption of the SIO-1087 shared { _error } envelope, mirroring the
// gitlab SIO-1179 pattern. The steering prose stays FIRST (the sub-agent LLM reads it and
// follows the embedded guidance); the JSON envelope is appended after it for the agent-side
// structured classifier. Whole-string JSON.parse fails on the mixed text, then the SIO-1159
// brace-recovery extracts the embedded {"_error":...} object -- so both consumers get what
// they need from one text block. The prose is duplicated into _error.advice unless the
// caller provides more specific advice.
export function envelopeText(prose: string, err: StructuredToolError): string {
	return `${prose}\n\n${JSON.stringify(buildToolErrorEnvelope({ advice: prose, ...err }))}`;
}

const TIMEOUT_PATTERN = /timed?\s*out|request timeout|ETIMEDOUT|-32001/i;
const NETWORK_PATTERN = /ECONNREFUSED|ECONNRESET|socket hang up|fetch failed|network/i;
// The Rovo upstream signals schema mismatches as -32602 "Input validation error".
const BAD_INPUT_PATTERN = /-32602|input validation error|invalid arguments/i;
// AtlassianUpstreamError samples carry the upstream HTTP status inside prose like
// "Search failed: 403 Forbidden" -- extract it so 401/403/404/429/5xx map correctly.
const HTTP_STATUS_PATTERN = /\b([45]\d\d)\b/;

export function classifyErrorMessage(message: string): ToolErrorKind {
	if (TIMEOUT_PATTERN.test(message)) return "timeout";
	if (NETWORK_PATTERN.test(message)) return "network";
	if (BAD_INPUT_PATTERN.test(message)) return "bad-input";
	return "unknown";
}

function classifyUpstreamError(message: string): ToolErrorKind {
	const status = HTTP_STATUS_PATTERN.exec(message)?.[1];
	if (status) return mapHttpStatusToKind(Number(status));
	const byMessage = classifyErrorMessage(message);
	// An upstream isError body with no status and no recognizable shape is still a
	// rejected call, not a transport mystery -- default to bad-input over unknown.
	return byMessage === "unknown" ? "bad-input" : byMessage;
}

// Shared error result for the generic proxy forwarder catch and the four custom-tool
// catches. Typed parse-layer errors carry their own kind; everything else classifies by
// message shape. Before SIO-1183 all of these surfaced as raw `Error: ...` prose, which
// the agent classified as "unknown" (degrading) -- the 07-15 -32001 timeout burst and the
// 07-13 fetch-failed runs both hit that path (SIO-1181 audit).
export function toolErrorResult(error: unknown): {
	content: Array<{ type: "text"; text: string }>;
	isError: true;
} {
	const message = error instanceof Error ? error.message : String(error);
	let kind: ToolErrorKind;
	if (error instanceof AtlassianAuthRequiredError) {
		kind = "auth-expired";
	} else if (error instanceof AtlassianUpstreamError) {
		kind = classifyUpstreamError(message);
	} else {
		kind = classifyErrorMessage(message);
	}
	return {
		content: [{ type: "text", text: envelopeText(`Error: ${message}`, { kind, message }) }],
		isError: true,
	};
}

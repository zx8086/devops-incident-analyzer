// src/tools/error-envelope.ts

import {
	buildToolErrorEnvelope,
	mapHttpStatusToKind,
	type StructuredToolError,
	type ToolErrorKind,
} from "@devops-agent/shared";
import { GitLabApiError } from "../gitlab-client/index.js";

// SIO-1179: gitlab adoption of the SIO-1087 shared { _error } envelope. The steering
// prose stays FIRST (the sub-agent LLM reads it and follows the embedded fallback
// guidance); the JSON envelope is appended after it for the agent-side structured
// classifier. Whole-string JSON.parse fails on the mixed text, then the SIO-1159
// brace-recovery extracts the embedded {"_error":...} object -- so both consumers
// get what they need from one text block. The prose is duplicated into
// _error.advice unless the caller provides more specific advice.
export function envelopeText(prose: string, err: StructuredToolError): string {
	return `${prose}\n\n${JSON.stringify(buildToolErrorEnvelope({ advice: prose, ...err }))}`;
}

const TIMEOUT_PATTERN = /timed?\s*out|request timeout|ETIMEDOUT|-32001/i;
const NETWORK_PATTERN = /ECONNREFUSED|ECONNRESET|socket hang up|fetch failed|network/i;

export function classifyErrorMessage(message: string): ToolErrorKind {
	if (TIMEOUT_PATTERN.test(message)) return "timeout";
	if (NETWORK_PATTERN.test(message)) return "network";
	return "unknown";
}

// Error result for the six code-analysis REST tools: GitLabApiError carries the real
// HTTP status (mapHttpStatusToKind); anything else classifies by message shape.
export function restErrorResult(error: unknown): {
	content: Array<{ type: "text"; text: string }>;
	isError: true;
} {
	const message = error instanceof Error ? error.message : String(error);
	const statusCode = error instanceof GitLabApiError ? error.statusCode : undefined;
	const kind = statusCode === undefined ? classifyErrorMessage(message) : mapHttpStatusToKind(statusCode);
	const prose = `Error: ${message}`;
	return {
		content: [{ type: "text", text: envelopeText(prose, { kind, message, statusCode }) }],
		isError: true,
	};
}

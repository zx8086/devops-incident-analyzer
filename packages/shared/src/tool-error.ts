// shared/src/tool-error.ts
// SIO-1087: the ONE cross-server structured-error mechanism. Every MCP server maps its OWN SDK's
// documented error type into the shared ToolErrorKind, then serializes a { _error } envelope with
// buildToolErrorEnvelope(). The agent reads that envelope structurally (kind/category) instead of
// regexing the human message. This replaces the per-server flatten-to-string + agent-side message
// regex with a single vocabulary defined in agent-state.ts.
import { TOOL_ERROR_KIND_TO_CATEGORY, type ToolErrorKind } from "./agent-state.ts";

// The structured payload a server attaches on a tool error. `kind` is the fine-grained, SDK-mapped
// discriminator; the agent derives the coarse category from it via TOOL_ERROR_KIND_TO_CATEGORY.
export interface StructuredToolError {
	kind: ToolErrorKind;
	message: string;
	// Optional remediation the server already knows (e.g. "fix the queryString, here's an example").
	advice?: string;
	// Structured HTTP/upstream metadata so rules never regex 5\d\d out of the message.
	statusCode?: number;
	hostname?: string;
	upstreamContentType?: string;
}

// The wire shape carried on a CallToolResult text block. Mirrors the AWS { _error } envelope so the
// agent's extractToolErrors has ONE shape to parse for all seven datasources.
export interface ToolErrorEnvelope {
	_error: StructuredToolError & { category: string };
}

export function buildToolErrorEnvelope(err: StructuredToolError): ToolErrorEnvelope {
	return {
		_error: {
			...err,
			category: TOOL_ERROR_KIND_TO_CATEGORY[err.kind],
		},
	};
}

// SIO-1087: shared HTTP-status -> kind mapping for the four HTTP-backed servers (konnect, gitlab,
// atlassian, and the elastic/kafka HTTP paths). Each server may override for a status it classifies
// more specifically (e.g. couchbase's index-code path), but this covers the common REST cases so the
// four proxies don't each reinvent 401->auth / 404->not-found / 429->throttled.
export function mapHttpStatusToKind(status: number | undefined): ToolErrorKind {
	if (status === undefined) return "unknown";
	if (status === 401 || status === 403) return "auth-denied";
	if (status === 404) return "not-found";
	if (status === 429) return "throttled";
	if (status >= 500 && status < 600) return "server-error";
	if (status >= 400 && status < 500) return "bad-input";
	return "unknown";
}

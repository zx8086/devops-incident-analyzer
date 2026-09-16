// packages/shared/src/tool-error.ts
// SIO-1087: the ONE cross-server structured-error mechanism. Every MCP server maps its OWN SDK's
// documented error type into the shared ToolErrorKind, then serializes a { _error } envelope with
// buildToolErrorEnvelope(). The agent reads that envelope structurally (kind/category) instead of
// regexing the human message. This replaces the per-server flatten-to-string + agent-side message
// regex with a single vocabulary defined in agent-state.ts.
import { z } from "zod";
import {
	TOOL_ERROR_KIND_TO_CATEGORY,
	type ToolErrorCategory,
	ToolErrorCategorySchema,
	type ToolErrorKind,
	ToolErrorKindSchema,
} from "./agent-state.ts";

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
	_error: StructuredToolError & { category: ToolErrorCategory };
}

// SIO-1119: runtime validation of the wire shape above, for callers that RECEIVE an envelope
// (tests, and any consumer parsing a CallToolResult text block). Kept in lockstep with the
// interface by construction -- both read the same kind/category enums. Deliberately NOT used by
// buildToolErrorEnvelope: producing the envelope is already type-safe, so validating our own
// output on every tool error would cost a parse per call for no signal.
export const ToolErrorEnvelopeSchema = z.object({
	_error: z
		.object({
			kind: ToolErrorKindSchema,
			category: ToolErrorCategorySchema,
			message: z.string(),
			advice: z.string().optional(),
			statusCode: z.number().optional(),
			hostname: z.string().optional(),
			upstreamContentType: z.string().optional(),
		})
		// Greptile on PR #795: validating kind and category INDEPENDENTLY accepts pairs the
		// producer can never emit -- buildToolErrorEnvelope always derives category from kind
		// via TOOL_ERROR_KIND_TO_CATEGORY, so e.g. { kind: "not-found", category: "auth" } is
		// impossible yet well-typed. That pair is not cosmetic: category decides degrading vs
		// non-degrading (agent-state.ts:107-111), so a consumer trusting a mismatched envelope
		// would mis-score datasource health. Reject the mismatch rather than silently honoring it.
		.refine((e) => e.category === TOOL_ERROR_KIND_TO_CATEGORY[e.kind], {
			message: "category must be the one derived from kind (see TOOL_ERROR_KIND_TO_CATEGORY)",
			path: ["category"],
		}),
});

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

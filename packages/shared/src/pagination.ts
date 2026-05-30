// shared/src/pagination.ts

import { z } from "zod";

// SIO-833: single source of truth for the sub-agent tool-result byte cap. Both the
// agent-side truncator (packages/agent/src/sub-agent-truncate-tool-output.ts) and the
// AWS MCP server's wrap*Tool (packages/mcp-server-aws/src/tools/wrap.ts) import this, so
// the two truncation layers can never drift. Raised 64KB -> 128KB: the AWS server caps
// at this value and the agent uses the same default, so the server's larger list payload
// (e.g. eu-mendix-platform-prd's ~155KB 17-node EKS describe) survives to the model
// instead of being re-truncated to 64KB agent-side. Per-process override via
// SUBAGENT_TOOL_RESULT_CAP_BYTES.
//
// Measurement caveat: the AWS wrapper sizes with JSON.stringify(...).length (UTF-16
// code units) while the agent truncator uses Buffer.byteLength(...,"utf8"). Both are
// conservative; do not assume byte-exact equality across the two layers.
export const DEFAULT_TOOL_RESULT_CAP_BYTES = 131_072;

// Headroom the AWS list truncator reserves for the _truncated marker while bisecting.
export const TRUNCATION_OVERHEAD_BYTES = 200;

// Per-server upstream page-size caps documented in one place; these mirror the limits
// already enforced in each server's tool schemas (see Phase 5 cross-server retrofit).
export const CANONICAL_LIMITS = {
	aws: 1000,
	kafka: 500,
	konnect: 1000,
	elastic: 1000,
	gitlab: 100,
} as const;

// Truncation markers. The AWS server (packages/mcp-server-aws/src/tools/types.ts)
// re-exports these so server and supervisor share one envelope. Every field beyond the
// original {shown,total,advice} / {atBytes,advice} is optional, so previously-serialized
// outputs still validate.
export interface ListTruncationMarker {
	shown: number;
	total: number;
	advice: string;
	// Present only when the upstream API returned a real continuation token.
	cursor?: string;
}

export interface BlobTruncationMarker {
	atBytes: number;
	advice: string;
}

export type TruncationMarker = ListTruncationMarker | BlobTruncationMarker;

// Validated when the supervisor reads untrusted tool output (e.g. extractFindings).
export const ListTruncationMarkerSchema = z.object({
	shown: z.number().int(),
	total: z.number().int(),
	advice: z.string(),
	cursor: z.string().optional(),
});

// Canonical paginated envelope. Servers may keep a domain-specific item key (e.g.
// kafka's `topics`) and attach the marker as a sibling; this is the shape the supervisor
// reasons about uniformly.
export interface PaginatedResponse<T> {
	items: T[];
	total: number;
	shown: number;
	truncated: boolean;
	advice?: string;
	cursor?: string;
}

export interface SliceArrayOptions {
	limit: number;
	offset: number;
}

// SIO-735 generalized: stateless offset/slice core shared by kafka's sliceTopics and any
// other server doing in-memory paging. Callers sort/filter first; this only does the
// offset math + truncated flag so the behavior is identical everywhere.
export function sliceArray<T>(items: T[], { limit, offset }: SliceArrayOptions): PaginatedResponse<T> {
	const total = items.length;
	const page = items.slice(offset, offset + limit);
	const truncated = offset + page.length < total;
	return { items: page, total, shown: page.length, truncated };
}

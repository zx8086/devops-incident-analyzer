// src/tools/types.ts
import type { BlobTruncationMarker, ListTruncationMarker } from "@devops-agent/shared";

// SIO-833: canonical truncation markers live in @devops-agent/shared; re-exported here so
// existing AWS-side imports keep resolving against one shared envelope shape.
export type { BlobTruncationMarker, ListTruncationMarker };

export type ToolErrorKind =
	| "assume-role-denied"
	| "iam-permission-missing"
	| "aws-throttled"
	| "bad-input"
	| "resource-not-found"
	| "aws-server-error"
	| "aws-network-error"
	| "aws-unknown";

export interface ToolError {
	kind: ToolErrorKind;
	action?: string; // e.g. "ec2:DescribeVpcs" — populated for iam-permission-missing
	awsErrorName?: string; // raw SDK error.name
	awsErrorMessage?: string; // raw SDK error.message
	awsRequestId?: string;
	httpStatusCode?: number;
	advice?: string;
}

export type ToolResult<TResponse> =
	| (TResponse & { _truncated?: ListTruncationMarker; _summary?: unknown })
	| { _raw: string; _truncated: BlobTruncationMarker }
	| { _error: ToolError };

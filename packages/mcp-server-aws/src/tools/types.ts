// src/tools/types.ts

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

export interface ListTruncationMarker {
	shown: number;
	total: number;
	advice: string;
}

export interface BlobTruncationMarker {
	atBytes: number;
	advice: string;
}

export type ToolResult<TResponse> =
	| (TResponse & { _truncated?: ListTruncationMarker })
	| { _raw: string; _truncated: BlobTruncationMarker }
	| { _error: ToolError };

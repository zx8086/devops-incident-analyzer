// src/tools/wrap.ts
import { logger } from "../utils/logger.ts";
import type { ToolError, ToolErrorKind } from "./types.ts";

interface AwsLikeError extends Error {
	$metadata?: { httpStatusCode?: number; requestId?: string };
	$service?: string;
}

function isAwsError(err: unknown): err is AwsLikeError {
	return err instanceof Error && "name" in err;
}

// "User is not authorized to perform: ec2:DescribeVpcs ..." -> "ec2:DescribeVpcs"
function extractAction(message: string): string | undefined {
	const m = message.match(/not authorized to perform:\s*([a-z][a-zA-Z0-9-]*:[A-Za-z0-9*]+)/i);
	return m?.[1];
}

const NETWORK_ERROR_PATTERNS = [/ENOTFOUND/, /ECONNREFUSED/, /ETIMEDOUT/, /EAI_AGAIN/, /socket hang up/];

export function mapAwsError(err: unknown): ToolError {
	if (!isAwsError(err)) {
		return { kind: "aws-unknown", awsErrorMessage: String(err) };
	}

	const base = {
		awsErrorName: err.name,
		awsErrorMessage: err.message,
		awsRequestId: err.$metadata?.requestId,
		httpStatusCode: err.$metadata?.httpStatusCode,
	};

	// Network errors come through without $metadata in many cases.
	if (!err.$metadata && NETWORK_ERROR_PATTERNS.some((re) => re.test(err.message))) {
		return { ...base, kind: "aws-network-error" };
	}

	let kind: ToolErrorKind;
	let action: string | undefined;

	switch (err.name) {
		// STS-style (AccessDenied) and service-style (AccessDeniedException) both
		// reach here. S3 v3 uses the bare AccessDenied for IAM-permission denials
		// (legacy XML naming), so both arms must inspect the message to decide
		// between trust-policy issues (sts:AssumeRole) and missing service actions.
		case "AccessDenied":
		case "AccessDeniedException": {
			action = extractAction(err.message);
			kind = action?.startsWith("sts:AssumeRole") ? "assume-role-denied" : "iam-permission-missing";
			break;
		}
		case "ThrottlingException":
		case "Throttling":
		case "TooManyRequestsException":
			kind = "aws-throttled";
			break;
		case "ValidationException":
		case "InvalidParameterValue":
		case "InvalidParameterException":
			kind = "bad-input";
			break;
		case "ResourceNotFoundException":
		case "NoSuchEntity":
			kind = "resource-not-found";
			break;
		case "ServiceUnavailable":
		case "InternalServerError":
		case "InternalFailure":
			kind = "aws-server-error";
			break;
		default:
			kind = "aws-unknown";
	}

	const toolError: ToolError = { ...base, kind };
	if (action) {
		toolError.action = action;
	}
	if (kind === "iam-permission-missing" && action) {
		toolError.advice = `Update DevOpsAgentReadOnlyPolicy to include "${action}", then re-run setup-aws-readonly-role.sh.`;
	} else if (kind === "assume-role-denied") {
		toolError.advice =
			"Check the DevOpsAgentReadOnly trust policy. Verify ExternalId and that the caller principal is allowed.";
	} else if (kind === "aws-throttled") {
		toolError.advice = "AWS throttled the call (SDK already retried 3 times). Narrow scope or wait before retrying.";
	} else if (kind === "resource-not-found") {
		toolError.advice =
			"The named resource does not exist in this account/region. Verify the identifier and the region; this may be a routine finding (resource deleted or never created).";
	}

	return toolError;
}

function logError(name: string, _err: unknown, mapped: ToolError, durationMs: number): void {
	logger.error(
		{
			tool: name,
			awsErrorName: mapped.awsErrorName,
			awsErrorMessage: mapped.awsErrorMessage,
			awsRequestId: mapped.awsRequestId,
			httpStatusCode: mapped.httpStatusCode,
			errorKind: mapped.kind,
			duration_ms: durationMs,
		},
		`AWS tool call failed: ${mapped.awsErrorName ?? "unknown"}`,
	);
}

interface WrapListArgs<TResponse, TParams> {
	name: string;
	listField: keyof TResponse;
	fn: (params: TParams) => Promise<TResponse>;
	capBytes?: number;
}

const FALLBACK_CAP_BYTES = 32_000;
const TRUNCATION_OVERHEAD_BYTES = 200;

// Mutable default so the bootstrap can apply SUBAGENT_TOOL_RESULT_CAP_BYTES once
// at startup without threading the value through every family factory.
// Per-call `capBytes` on wrap*Tool args still wins.
let defaultCapBytes = FALLBACK_CAP_BYTES;

export function setDefaultCapBytes(n: number): void {
	if (Number.isFinite(n) && n > 0) defaultCapBytes = n;
}

export function wrapListTool<TResponse, TParams>(
	args: WrapListArgs<TResponse, TParams>,
): (params: TParams) => Promise<TResponse | { _error: ToolError }> {
	return async (params: TParams) => {
		const cap = args.capBytes ?? defaultCapBytes;
		const start = Date.now();
		let response: TResponse;
		try {
			response = await args.fn(params);
		} catch (err) {
			const mapped = mapAwsError(err);
			logError(args.name, err, mapped, Date.now() - start);
			return { _error: mapped };
		}

		const list = response[args.listField] as unknown as unknown[] | undefined;
		if (!Array.isArray(list)) return response;

		// Serialize the whole response once to check size.
		const full = JSON.stringify(response);
		if (full.length <= cap) return response;

		// Need to truncate the list. Bisect to find the max items that fit.
		const total = list.length;
		let lo = 0;
		let hi = total;
		while (lo < hi) {
			const mid = Math.ceil((lo + hi) / 2);
			const candidate = { ...response, [args.listField]: list.slice(0, mid) };
			const size = JSON.stringify(candidate).length + TRUNCATION_OVERHEAD_BYTES;
			if (size <= cap) lo = mid;
			else hi = mid - 1;
		}

		const shown = lo;
		const truncated = {
			...response,
			[args.listField]: list.slice(0, shown),
			_truncated: {
				shown,
				total,
				advice: `Response truncated. Add a filter or narrower time window to fit more of ${total} items.`,
			},
		};
		return truncated as TResponse;
	};
}

interface WrapBlobArgs<TResponse, TParams> {
	name: string;
	fn: (params: TParams) => Promise<TResponse>;
	capBytes?: number;
}

export function wrapBlobTool<TResponse, TParams>(
	args: WrapBlobArgs<TResponse, TParams>,
): (
	params: TParams,
) => Promise<TResponse | { _raw: string; _truncated: { atBytes: number; advice: string } } | { _error: ToolError }> {
	return async (params: TParams) => {
		const cap = args.capBytes ?? defaultCapBytes;
		const start = Date.now();
		let response: TResponse;
		try {
			response = await args.fn(params);
		} catch (err) {
			const mapped = mapAwsError(err);
			logError(args.name, err, mapped, Date.now() - start);
			return { _error: mapped };
		}

		const serialized = JSON.stringify(response);
		if (serialized.length <= cap) return response;

		// Byte-cap with walkback to last comma or close-bracket so the raw stays
		// readable to the model. Not required to be parseable JSON.
		let cut = serialized.slice(0, cap);
		const walkbackIdx = Math.max(cut.lastIndexOf(","), cut.lastIndexOf("]"), cut.lastIndexOf("}"));
		if (walkbackIdx > cap * 0.5) cut = cut.slice(0, walkbackIdx + 1);

		return {
			_raw: cut,
			_truncated: {
				atBytes: cut.length,
				advice: "Response too large for a single tool call. Narrow scope (time window, filters, IDs) and retry.",
			},
		};
	};
}

// wrap*Tool returns raw SDK shape; MCP server.tool() expects { content: [{ type, text }] }.
// Every family index.ts bridges via toMcp(await handler(params)).
export function toMcp(result: unknown): { content: [{ type: "text"; text: string }] } {
	return { content: [{ type: "text", text: JSON.stringify(result) }] };
}

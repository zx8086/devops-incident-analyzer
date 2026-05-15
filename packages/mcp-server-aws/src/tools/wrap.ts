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
	const m = message.match(/not authorized to perform:\s*([a-z][a-zA-Z0-9-]*:[A-Za-z0-9*]+)/);
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
		case "AccessDenied": // STS-style
			kind = "assume-role-denied";
			break;
		case "AccessDeniedException": {
			action = extractAction(err.message);
			// If the action is sts:AssumeRole, treat as assume-role-denied even when
			// the error name is AccessDeniedException rather than AccessDenied.
			if (action?.startsWith("sts:AssumeRole")) {
				kind = "assume-role-denied";
			} else {
				kind = "iam-permission-missing";
			}
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

const DEFAULT_CAP_BYTES = 32_000;
const TRUNCATION_OVERHEAD_BYTES = 200;

export function wrapListTool<TResponse, TParams>(
	args: WrapListArgs<TResponse, TParams>,
): (params: TParams) => Promise<TResponse | { _error: ToolError }> {
	const cap = args.capBytes ?? DEFAULT_CAP_BYTES;
	return async (params: TParams) => {
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
	const cap = args.capBytes ?? DEFAULT_CAP_BYTES;
	return async (params: TParams) => {
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

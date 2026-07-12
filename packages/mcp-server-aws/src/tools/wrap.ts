// src/tools/wrap.ts
import { DEFAULT_TOOL_RESULT_CAP_BYTES, TRUNCATION_OVERHEAD_BYTES } from "@devops-agent/shared";
import { logger } from "../utils/logger.ts";
import type { ToolError, ToolErrorKind } from "./types.ts";

interface AwsLikeError extends Error {
	$metadata?: { httpStatusCode?: number; requestId?: string };
	$service?: string;
	// SIO-1087: the documented smithy client/server discriminator. "client" = 4xx (bad input,
	// authz, not-found -- not retryable); "server" = 5xx (retryable). Previously never read.
	$fault?: "client" | "server";
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

// SIO-1087: HTTP-status class helpers so a novel/unmapped AWS error name still classifies by the
// documented $metadata.httpStatusCode instead of collapsing to aws-unknown.
function isServerStatus(status: number | undefined): boolean {
	return status !== undefined && status >= 500 && status < 600;
}
function isClientStatus(status: number | undefined): boolean {
	return status !== undefined && status >= 400 && status < 500;
}

// SIO-1078: CloudWatch Logs Insights retention-window rejection text. Distinctive enough
// to classify even if the error surfaces under an unexpected name.
const RETENTION_WINDOW_PATTERN = /end date and time is either before the log group|exceeds the log group.*retention/i;

// SIO-1085: a MalformedQueryException can ALSO be a query-STRING syntax error (e.g.
// "Invalid syntax while using query definition snippets: unexpected symbol found ...",
// "Unknown function", "unexpected token"). This is NOT a window problem -- re-anchoring
// the time window does nothing; the queryString itself must be fixed. Distinguish it so
// the advice steers the LLM to correct the syntax instead of endlessly re-anchoring.
const QUERY_SYNTAX_PATTERN =
	/invalid syntax|unexpected symbol|unexpected token|unknown function|parse error|query definition snippets/i;

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
		// SIO-1078: CloudWatch Logs Insights rejects a query window that predates a log
		// group's retention/creation with MalformedQueryException. It is a bad-input the LLM
		// must fix (narrow the window) -- never transient; retrying the same window never
		// succeeds. Reused kind "bad-input" already maps to the "unknown" toolError category
		// agent-side, so no agent change is needed.
		case "MalformedQueryException":
			kind = "bad-input";
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
			// SIO-1078: defensive fallback -- if the retention-window rejection ever arrives
			// under a different error name, the message text is distinctive enough to classify.
			// SIO-1087: for any other novel error name, use the documented $fault/httpStatusCode
			// discriminators instead of falling straight to aws-unknown -- a server-side (5xx)
			// failure is retryable, a client-side (4xx) one is not.
			if (RETENTION_WINDOW_PATTERN.test(err.message)) {
				kind = "bad-input";
			} else if (err.$fault === "server" || isServerStatus(err.$metadata?.httpStatusCode)) {
				kind = "aws-server-error";
			} else if (err.$fault === "client" || isClientStatus(err.$metadata?.httpStatusCode)) {
				kind = "bad-input";
			} else {
				kind = "aws-unknown";
			}
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
	} else if (kind === "bad-input" && err.name === "MalformedQueryException" && QUERY_SYNTAX_PATTERN.test(err.message)) {
		// SIO-1085: a query-STRING syntax error, NOT a window problem. Re-anchoring the
		// time window does nothing. Steer the LLM to fix the queryString and give it a
		// known-good example so it stops re-issuing the same broken query. GATED on the
		// exact error NAME so a generic ValidationException/InvalidParameterException
		// (also bad-input) that happens to contain "unexpected token"/"parse error" in
		// its message keeps its own remediation instead of being told to rewrite a query.
		toolError.advice =
			"This is a query SYNTAX error in queryString, NOT a time-window/retention problem -- do NOT re-anchor the window or retry the same query. Fix the CloudWatch Logs Insights syntax. A known-good minimal query is: `fields @timestamp, @message | filter @message like /THE1/ | sort @timestamp desc | limit 20` (each command on its own is separated by `|`; use `filter ... like /regex/` to match text, `fields` to select columns). If the account rejects standard Logs Insights syntax, drop the query to just `fields @timestamp, @message | limit 20` and filter client-side.";
	} else if (
		kind === "bad-input" &&
		(err.name === "MalformedQueryException" || RETENTION_WINDOW_PATTERN.test(err.message))
	) {
		// SIO-1078: distinguish a retention-window rejection from a generic validation error
		// so the LLM stops retrying an unrecoverable window and pivots to another source.
		// SIO-1079: a MalformedQueryException means the requested WINDOW is outside retention,
		// NOT that the incident's logs are expired. The window is almost always mis-anchored
		// (an incident is usually recent). Steer to re-anchoring; only call it expired if the
		// incident itself predates retention.
		toolError.advice =
			"The requested query window is outside the log group's retention or predates its creation -- this does NOT mean the incident's logs are expired. CloudWatch Logs Insights only returns data within the retention window. Call aws_logs_describe_log_groups to read retentionInDays and creationTime, then re-anchor startTime/endTime to the incident/event timestamp (usually recent) within [now - retentionInDays, now]. Do not retry the same window; only conclude the logs are expired if the incident itself predates retention.";
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

// SIO-838: resolve a canonical pagination alias (limit/cursor) against a tool's SDK-specific
// param (MaxRecords/NextToken/Marker/...). The SDK-named value wins when both are supplied so
// existing call patterns are never overridden; uses ?? (not ||) so a legitimate 0 page-size or
// empty token is respected. Aliases exist so the sub-agent can paginate every list tool uniformly
// and walk all pages -- it is about complete retrieval, never dropping data.
export function preferSdkParam<T>(sdkValue: T | undefined, aliasValue: T | undefined): T | undefined {
	return sdkValue ?? aliasValue;
}

interface WrapListArgs<TResponse, TParams> {
	name: string;
	listField: keyof TResponse;
	fn: (params: TParams) => Promise<TResponse>;
	capBytes?: number;
	// SIO-833: when truncation fires, attach a compact projection of the COMPLETE
	// pre-slice response as `_summary` so typed-finding extractors stay complete even
	// though the full list is truncated for the model's context. Must stay small
	// (scalar fields only) so it never re-trips the cap.
	summarize?: (response: TResponse) => unknown;
}

function trySummarize<T>(name: string, fn: (r: T) => unknown, response: T): unknown {
	try {
		return fn(response);
	} catch (err) {
		logger.warn({ tool: name, err: String(err) }, "wrapListTool summarize projection failed; omitting _summary");
		return undefined;
	}
}

// SIO-833: AWS continuation-token field names across services. wrapListTool probes these so
// it can surface a real token as the machine-readable _truncated.cursor (Case A) and
// distinguish it from a no-token byte-truncation (Case B), instead of relying on the model
// to scan the raw response.
// NextMarker is Lambda's response token (the input arg is Marker -- a name difference, not
// just case), so it must be probed here or aws_lambda_list_functions is misclassified as a
// no-token Case B byte-truncation when it is actually a chainable Case A page.
const TOKEN_FIELDS = ["NextToken", "nextToken", "Marker", "NextMarker", "PaginationToken"] as const;

function findContinuationToken(response: unknown): string | undefined {
	if (!response || typeof response !== "object") return undefined;
	const obj = response as Record<string, unknown>;
	for (const field of TOKEN_FIELDS) {
		const value = obj[field];
		if (typeof value === "string" && value.length > 0) return value;
	}
	return undefined;
}

// SIO-833: cap + overhead live in @devops-agent/shared so this server and the agent-side
// truncator (packages/agent/src/sub-agent-truncate-tool-output.ts) share one source of truth
// and cannot drift. Bootstrap can still override via SUBAGENT_TOOL_RESULT_CAP_BYTES.

// Mutable default so the bootstrap can apply SUBAGENT_TOOL_RESULT_CAP_BYTES once
// at startup without threading the value through every family factory.
// Per-call `capBytes` on wrap*Tool args still wins.
let defaultCapBytes = DEFAULT_TOOL_RESULT_CAP_BYTES;

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

		// Compute _summary before bisecting so its serialized bytes are reserved in the budget.
		// _summary is appended to the final object, so a large one that isn't accounted for here
		// can push the wrapped result back over cap; the agent-side truncator would then byte-slice
		// the tail _summary away, defeating the findings-completeness guarantee it exists for.
		const summary = args.summarize ? trySummarize(args.name, args.summarize, response) : undefined;
		const reserve = TRUNCATION_OVERHEAD_BYTES + (summary === undefined ? 0 : JSON.stringify(summary).length);

		// Need to truncate the list. Bisect to find the max items that fit.
		const total = list.length;
		let lo = 0;
		let hi = total;
		while (lo < hi) {
			const mid = Math.ceil((lo + hi) / 2);
			const candidate = { ...response, [args.listField]: list.slice(0, mid) };
			const size = JSON.stringify(candidate).length + reserve;
			if (size <= cap) lo = mid;
			else hi = mid - 1;
		}

		const shown = lo;
		// SIO-833: surface a real continuation token as a machine-readable cursor so the model
		// can tell Case A (chainable) from Case B (byte-truncated, no token) without scanning
		// the raw response. A real token can co-occur with byte-truncation.
		const cursor = findContinuationToken(response);
		const baseAdvice =
			cursor === undefined
				? "Byte-truncated to fit the size cap with no pagination token (Case B): re-invoking unchanged returns the same result -- add a filter or pass a smaller maxResults to obtain a token, then chain."
				: "More pages available (Case A): pass _truncated.cursor back as this tool's pagination argument (NextToken/nextToken/Marker) to fetch the next page.";
		const truncated = {
			...response,
			[args.listField]: list.slice(0, shown),
			_truncated: {
				shown,
				total,
				...(cursor === undefined ? {} : { cursor }),
				advice:
					summary === undefined ? baseAdvice : `Complete items for counts and coverage are in _summary. ${baseAdvice}`,
			},
			...(summary === undefined ? {} : { _summary: summary }),
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

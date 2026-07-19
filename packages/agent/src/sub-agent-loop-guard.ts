// packages/agent/src/sub-agent-loop-guard.ts

import { describeToolResult } from "./sub-agent-tool-result-shape.ts";

// SIO-1029/SIO-1090: the elastic ReAct sub-agent can loop on elasticsearch_search
// because an empty search is a valid 200 result ("Total results: 0, showing 0 from
// position 0"), not an error. Under SIO-1090 the SOUL/focus-block now issue ONE broad
// multi_match query over logs-*,logs-apm.* wide by default, so the narrow-window thrash
// that motivated the widen/latch/discovery-aware machinery is gone. This guard is now
// just two termination guarantees: (1) an exact-duplicate (tool,args) call is stopped,
// and (2) a hard cap on total unproductive elasticsearch_search calls stops a permuter
// well under recursionLimit 40. A single service.name discovery agg is never stopped
// below the cap so the discover step always runs. AWS aws_logs_start_query guarding
// (retention re-anchor) is unchanged.

const GUARDED_TOOLS = new Set<string>(["elasticsearch_search", "aws_logs_start_query"]);

const AWS_DESCRIBE_LOG_GROUPS = "aws_logs_describe_log_groups";

// SIO-1159: a successful-but-empty CloudWatch query carries no _error, so the
// SIO-1141 re-anchor machinery never fires on it -- run 270378e0 queried a 24h
// window that silently missed a 2-day-old incident. Track consecutive
// Complete-with-0-rows aws_logs_get_query_results and emit one-shot widen advice.
const AWS_GET_QUERY_RESULTS = "aws_logs_get_query_results";
const AWS_EMPTY_RESULTS_ADVICE_THRESHOLD = 2;

// An empty elasticsearch_search renders as "Total results: 0, showing 0 ...".
const EMPTY_SEARCH_RE = /Total results:\s*0\b/i;

// SIO-1084: AWS tool results carry an {_error:{kind,...}} envelope on failure. The
// looping kinds are the retention-window rejection (bad-input) and wrong-group
// (resource-not-found).
const AWS_LOOPING_ERROR_KINDS = new Set<string>(["bad-input", "resource-not-found"]);

// SIO-1090: absolute cap on TOTAL unproductive elasticsearch_search calls in one
// sub-agent run. The termination backstop even if the LLM permutes distinct args; well
// under recursionLimit 40. One broad query should suffice, so this is generous headroom.
const MAX_UNPRODUCTIVE_SEARCHES = 5;

// SIO-1141: absolute cap on TOTAL unproductive aws_logs_start_query calls in one sub-agent
// run. Distinct (re-anchored) windows are allowed to retry, but a permuter that keeps landing
// outside retention must still terminate. Generous enough to cover: initial fail -> describe ->
// corrected retry -> (worst case) one more describe + corrected retry, before giving up.
const MAX_AWS_START_QUERY_UNPRODUCTIVE = 4;

export const LOOP_GUARD_STOP_MESSAGE =
	"No results for this query, and equivalent searches have already returned nothing. " +
	"Stop searching -- do not call this tool again with a similar query. Synthesize your " +
	"findings from the data you have gathered so far. If the discovery aggregation surfaced " +
	"a candidate service.name you have not yet confirmed, treat the service as present under " +
	"that name; only if discovery surfaced no matching service at all, report that the " +
	"searched indices/patterns returned no matching documents.";

export const AWS_EMPTY_RESULTS_ADVICE =
	"[loop-guard advice] The last two aws_logs_get_query_results calls completed successfully " +
	"with 0 rows. An empty result from a narrow time window looks identical to 'no logs exist'. " +
	"Before concluding absence, re-run the query ONCE with startRelative now-30d (or a window " +
	"that reaches back past the incident time); only report absence if the widened query is " +
	"also empty.";

export const AWS_START_QUERY_STOP_MESSAGE =
	"The previous aws_logs_start_query window was rejected as outside the log group's " +
	"retention window, and you have not re-anchored since. Do NOT re-issue the same query. " +
	"Call aws_logs_describe_log_groups first to read retentionInDays and creationTime, then " +
	"re-anchor startTime/endTime to the incident/event timestamp (usually recent) inside " +
	"[now - retentionInDays, now] before calling aws_logs_start_query again.";

export interface LoopGuardState {
	seenSignatures: Set<string>;
	// SIO-1090: TOTAL unproductive elasticsearch_search calls this run. Drives the
	// MAX_UNPRODUCTIVE_SEARCHES backstop.
	unproductiveSearches: number;
	// SIO-1084: set when the last aws_logs_start_query returned a retention/bad-input
	// _error; cleared by an intervening aws_logs_describe_log_groups. Used only to select
	// the stop MESSAGE (re-anchor advice); it no longer gates a distinct-window retry.
	awsStartQueryNeedsReanchor: boolean;
	// SIO-1141: TOTAL unproductive aws_logs_start_query calls this run. A retention/bad-input
	// rejection used to latch awsStartQueryNeedsReanchor and block EVERY subsequent start_query
	// -- even a genuinely re-anchored (distinct-window) retry -- until a describe ran. That is
	// wrong: a changed window IS a re-anchor attempt and must be allowed. We now allow distinct
	// windows and instead bound the total unproductive attempts (mirrors MAX_UNPRODUCTIVE_SEARCHES)
	// so a permuter that keeps landing outside retention still terminates.
	awsStartQueryUnproductive: number;
	// SIO-1159: consecutive Complete-with-0-rows aws_logs_get_query_results. Reset by any
	// non-empty result; consumed (reset) when the widen advice is emitted.
	awsEmptyQueryResults: number;
}

export function createLoopGuardState(): LoopGuardState {
	return {
		seenSignatures: new Set<string>(),
		unproductiveSearches: 0,
		awsStartQueryNeedsReanchor: false,
		awsStartQueryUnproductive: 0,
		awsEmptyQueryResults: 0,
	};
}

// SIO-1084: In the ReAct/ToolNode path invoke() receives { id, name, args, type }, not
// the bare args. Unwrap so the signature/discovery detection key on args.
export function unwrapCallArgs(arg: unknown): unknown {
	if (arg && typeof arg === "object" && "args" in arg && !Array.isArray(arg)) {
		return (arg as { args: unknown }).args;
	}
	return arg;
}

export function toolCallSignature(toolName: string, arg: unknown): string {
	return `${toolName}::${stableStringify(unwrapCallArgs(arg))}`;
}

function stableStringify(value: unknown): string {
	if (value === null || typeof value !== "object") {
		return JSON.stringify(value) ?? "null";
	}
	if (Array.isArray(value)) {
		return `[${value.map(stableStringify).join(",")}]`;
	}
	const obj = value as Record<string, unknown>;
	const keys = Object.keys(obj).sort();
	return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

// SIO-1084/1090: a service.name discovery aggregation is `size: 0` with a terms agg on
// `service.name`. It is bounded and load-bearing (the discover step), so the guard never
// stops the FIRST one below the hard cap.
export function isDiscoveryCall(arg: unknown): boolean {
	const args = unwrapCallArgs(arg);
	if (!args || typeof args !== "object") return false;
	const obj = args as Record<string, unknown>;
	if (obj.size !== 0) return false;
	const aggs = obj.aggs ?? obj.aggregations;
	return aggsTargetServiceName(aggs);
}

function aggsTargetServiceName(aggs: unknown): boolean {
	if (!aggs || typeof aggs !== "object") return false;
	for (const node of Object.values(aggs as Record<string, unknown>)) {
		if (!node || typeof node !== "object") continue;
		const terms = (node as Record<string, unknown>).terms;
		if (terms && typeof terms === "object") {
			const field = (terms as Record<string, unknown>).field;
			if (field === "service.name") return true;
		}
		const nested = (node as Record<string, unknown>).aggs ?? (node as Record<string, unknown>).aggregations;
		if (aggsTargetServiceName(nested)) return true;
	}
	return false;
}

export function awsErrorKind(content: unknown): string | null {
	const text = typeof content === "string" ? content : safeStringify(content);
	if (!text.includes("_error")) return null;
	const start = text.indexOf("{");
	if (start === -1) return null;
	try {
		const parsed = JSON.parse(text.slice(start));
		if (parsed && typeof parsed === "object") {
			const err = (parsed as Record<string, unknown>)._error;
			if (err && typeof err === "object") {
				const kind = (err as Record<string, unknown>).kind;
				return typeof kind === "string" ? kind : "unknown";
			}
		}
	} catch {
		return null;
	}
	return null;
}

function parseAwsQueryResults(content: unknown): { status: string; resultCount: number } | null {
	const text = typeof content === "string" ? content : safeStringify(content);
	if (!text.includes('"status"')) return null;
	const start = text.indexOf("{");
	if (start === -1) return null;
	try {
		const parsed = JSON.parse(text.slice(start));
		if (!parsed || typeof parsed !== "object") return null;
		const obj = parsed as Record<string, unknown>;
		if (typeof obj.status !== "string" || !Array.isArray(obj.results)) return null;
		return { status: obj.status, resultCount: obj.results.length };
	} catch {
		return null;
	}
}

// SIO-1159: detect a successful-but-empty CloudWatch Logs Insights result --
// {status:"Complete", results:[]}. Distinct from isUnproductiveResult: this is a
// SUCCESS shape (no _error), which the SIO-1141 machinery deliberately ignores.
export function isEmptyAwsQueryResults(content: unknown): boolean {
	const parsed = parseAwsQueryResults(content);
	return parsed !== null && parsed.status === "Complete" && parsed.resultCount === 0;
}

// Scheduled/Running polls are in-flight, not outcomes -- they must be NEUTRAL for the
// consecutive-empty counter, else the poll loop between two empty queries resets it.
function isInFlightAwsQueryResults(content: unknown): boolean {
	const parsed = parseAwsQueryResults(content);
	return parsed !== null && (parsed.status === "Running" || parsed.status === "Scheduled");
}

// SIO-1159: one-shot widen advice after N consecutive empty-success results. Consuming
// resets the counter so the advice is appended once, not to every subsequent call.
export function consumeEmptyAwsResultsAdvice(state: LoopGuardState): string | null {
	if (state.awsEmptyQueryResults < AWS_EMPTY_RESULTS_ADVICE_THRESHOLD) return null;
	state.awsEmptyQueryResults = 0;
	return AWS_EMPTY_RESULTS_ADVICE;
}

function safeStringify(value: unknown): string {
	if (value === undefined || value === null) return "";
	try {
		return JSON.stringify(value) ?? "";
	} catch {
		return String(value);
	}
}

// SIO-1086: the elastic MCP renders a search/agg result as an ARRAY of text blocks;
// @langchain/mcp-adapters delivers that array RAW. Coalesce a text-block array back to
// the string it logically is so the string checks below apply.
function coalesceTextBlocks(content: unknown): string | null {
	if (!Array.isArray(content) || content.length === 0) return null;
	const texts: string[] = [];
	for (const block of content) {
		if (block && typeof block === "object" && "text" in block) {
			const t = (block as { text?: unknown }).text;
			if (typeof t === "string") texts.push(t);
		}
	}
	return texts.length > 0 ? texts.join("\n\n") : null;
}

// A result is "unproductive" when it carries no usable data. Elastic: explicit empty
// search, empty content, empty array, or zero-bucket aggregation. AWS start_query: an
// _error envelope with a looping kind.
export function isUnproductiveResult(content: unknown, toolName?: string): boolean {
	if (toolName === "aws_logs_start_query") {
		const kind = awsErrorKind(content);
		return kind !== null && AWS_LOOPING_ERROR_KINDS.has(kind);
	}
	const coalesced = coalesceTextBlocks(content);
	const asText = typeof content === "string" ? content : coalesced;
	if (typeof asText === "string") {
		if (asText.length === 0) return true;
		if (EMPTY_SEARCH_RE.test(asText)) return true;
		if (isEmptyAggregationResult(asText)) return true;
	}
	const { shape } = describeToolResult(asText ?? content);
	if (shape.contentType === "empty") return true;
	if (shape.contentType === "array" && shape.topLevelArrayLen === 0) return true;
	if (shape.contentType === "object" && shape.hitsLen === 0) return true;
	return false;
}

function isEmptyAggregationResult(text: string): boolean {
	if (!/aggregations/i.test(text)) return false;
	const start = text.indexOf("{");
	if (start === -1) return false;
	let parsed: unknown;
	try {
		parsed = JSON.parse(text.slice(start));
	} catch {
		return false;
	}
	if (!parsed || typeof parsed !== "object") return false;
	return aggregationsAreEmpty(parsed as Record<string, unknown>);
}

function aggregationsAreEmpty(node: Record<string, unknown>): boolean {
	let sawBuckets = false;
	let allEmpty = true;
	const walk = (obj: Record<string, unknown>): void => {
		for (const value of Object.values(obj)) {
			if (!value || typeof value !== "object") continue;
			const buckets = (value as Record<string, unknown>).buckets;
			if (Array.isArray(buckets)) {
				sawBuckets = true;
				if (buckets.length > 0) allEmpty = false;
			}
			walk(value as Record<string, unknown>);
		}
	};
	walk(node);
	return sawBuckets && allEmpty;
}

// Decide BEFORE invoking whether this call should be short-circuited. Trips when the
// exact same (tool, args) call was already seen, OR (elastic) the hard unproductive-call
// cap is exhausted, OR (aws) a prior retention rejection has not yet been re-anchored.
export function shouldShortCircuit(state: LoopGuardState, toolName: string, signature: string, arg?: unknown): boolean {
	if (!GUARDED_TOOLS.has(toolName)) return false;

	if (toolName === "aws_logs_start_query") {
		// Exact-duplicate window: never re-issue the identical call.
		if (state.seenSignatures.has(signature)) return true;
		// SIO-1141: hard termination backstop -- stop once total unproductive start_query
		// attempts hit the cap (mirrors the elastic MAX_UNPRODUCTIVE_SEARCHES). A DISTINCT
		// window below the cap is a legitimate re-anchor attempt and is allowed to proceed,
		// so the agent can correct its window (or interleave a describe) instead of being
		// blocked on the first bad-input. (Pre-SIO-1141 this returned true whenever the
		// awsStartQueryNeedsReanchor latch was set, which blocked corrected retries too.)
		if (state.awsStartQueryUnproductive >= MAX_AWS_START_QUERY_UNPRODUCTIVE) return true;
		return false;
	}

	// elasticsearch_search
	if (state.seenSignatures.has(signature)) return true;
	// Hard termination backstop: once TOTAL unproductive searches hit the cap, stop
	// unconditionally -- even a discovery call.
	if (state.unproductiveSearches >= MAX_UNPRODUCTIVE_SEARCHES) return true;
	// Below the cap nothing else stops an elasticsearch_search -- a fresh service.name
	// discovery agg is bounded + load-bearing, and a distinct broad query is what SIO-1090
	// wants. `isDiscoveryCall` is checked explicitly (even though the fallthrough is also
	// `false`) as a deliberate guard-point: if a future stop rule is added here, it must be
	// placed AFTER this line so it can never short-circuit the discover step.
	if (isDiscoveryCall(arg)) return false;
	return false;
}

// SIO-1084: reserve a guarded call's signature BEFORE invoking so a concurrent identical
// call is caught as a duplicate. Idempotent.
export function reserveSignature(state: LoopGuardState, toolName: string, signature: string): void {
	if (!GUARDED_TOOLS.has(toolName)) return;
	state.seenSignatures.add(signature);
}

// Update state AFTER a real (non-short-circuited) call completes.
export function recordResult(
	state: LoopGuardState,
	toolName: string,
	signature: string,
	content: unknown,
	_arg?: unknown,
): void {
	if (toolName === AWS_DESCRIBE_LOG_GROUPS) {
		state.awsStartQueryNeedsReanchor = false;
		// SIO-1141: a fresh describe gives the agent the retention/creation facts it needs to
		// build a valid window, so reset the unproductive counter -- the post-describe retry
		// is a genuine fresh start, not a continuation of the pre-describe permutation.
		state.awsStartQueryUnproductive = 0;
		return;
	}
	if (toolName === AWS_GET_QUERY_RESULTS) {
		// SIO-1159: count consecutive empty-success outcomes. In-flight polls
		// (Running/Scheduled) are neutral; a Complete with rows (or error) resets.
		if (isEmptyAwsQueryResults(content)) {
			state.awsEmptyQueryResults += 1;
		} else if (!isInFlightAwsQueryResults(content)) {
			state.awsEmptyQueryResults = 0;
		}
		return;
	}
	if (!GUARDED_TOOLS.has(toolName)) return;

	state.seenSignatures.add(signature);

	if (toolName === "aws_logs_start_query") {
		const unproductive = isUnproductiveResult(content, toolName);
		// Keep the latch for stop-MESSAGE selection (re-anchor advice), and count total
		// unproductive attempts for the SIO-1141 termination backstop. A productive result
		// clears both so a later unrelated failure starts fresh.
		state.awsStartQueryNeedsReanchor = unproductive;
		if (unproductive) {
			state.awsStartQueryUnproductive += 1;
		} else {
			state.awsStartQueryUnproductive = 0;
		}
		return;
	}

	// elasticsearch_search
	if (isUnproductiveResult(content, toolName)) {
		state.unproductiveSearches += 1;
	}
}

export function isGuardedTool(toolName: string): boolean {
	return GUARDED_TOOLS.has(toolName);
}

export function isObservedTool(toolName: string): boolean {
	return GUARDED_TOOLS.has(toolName) || toolName === AWS_DESCRIBE_LOG_GROUPS || toolName === AWS_GET_QUERY_RESULTS;
}

// SIO-1084/1090: select the stop message for a guarded tool. `state` is accepted for a
// stable signature with the call site but is no longer needed to choose the elastic
// message (only one remains).
export function stopMessageFor(toolName: string, _state?: LoopGuardState): string {
	if (toolName === "aws_logs_start_query") return AWS_START_QUERY_STOP_MESSAGE;
	return LOOP_GUARD_STOP_MESSAGE;
}

// packages/agent/src/sub-agent-loop-guard.ts

import { describeToolResult } from "./sub-agent-tool-result-shape.ts";

// SIO-1029: the elastic ReAct sub-agent loops on elasticsearch_search. An empty
// search is a valid 200 result -- the literal string
// "Total results: 0, showing 0 from position 0" (mcp-server-elastic search.ts)
// -- NOT an error, so the LLM keeps permuting index patterns/queries until it
// blows the recursion limit (40) and the whole datasource returns nothing. This
// module makes repetition terminal: after two consecutive unproductive searches
// (or an exact-duplicate call), the guard returns a stop-and-synthesize string
// to the LLM instead of re-hitting ES. Conservative by design -- it only trips
// on a real repeat, so legitimate progressive refinement (SIO-689) is untouched.
//
// SIO-1084: two extensions.
//  - Elastic guard is now DISCOVERY-AWARE. The SOUL step "run one service.name
//    terms-agg over logs-*,logs-apm.* before declaring a named service absent"
//    was being killed because two literal-name empties tripped the stop BEFORE
//    the discovery agg could run. The guard now never stops a discovery agg, and
//    does not fire the consecutive-empty stop until at least one discovery agg
//    has run (`discoveryRan`).
//  - aws_logs_start_query is now guarded too. Its failure mode is re-issuing an
//    identical retention-window-rejected query (MalformedQueryException -> _error
//    kind "bad-input") many times. After such a rejection the guard requires an
//    intervening aws_logs_describe_log_groups (to read retention/creation and
//    re-anchor) before the next start_query is allowed.

// Only guard tools that actually loop. Kept as a set so a future looping tool
// can be added without touching the instrumentation call site.
const GUARDED_TOOLS = new Set<string>(["elasticsearch_search", "aws_logs_start_query"]);

// aws_logs_describe_log_groups is NOT guarded (it never loops), but it IS
// observed: seeing it clears the "must re-anchor" flag set by a rejected
// start_query, so the agent can retry start_query once it has re-read retention.
const AWS_DESCRIBE_LOG_GROUPS = "aws_logs_describe_log_groups";

// An empty elasticsearch_search renders as "Total results: 0, showing 0 ...".
const EMPTY_SEARCH_RE = /Total results:\s*0\b/i;

// SIO-1084: AWS tool results are a SUCCESSFUL MCP payload that carries an
// {_error:{kind,...}} envelope on failure (packages/mcp-server-aws wrap.ts). The
// looping kinds are the retention-window rejection (bad-input) and wrong-group
// (resource-not-found); auth/throttle are terminal/transient and handled elsewhere.
const AWS_LOOPING_ERROR_KINDS = new Set<string>(["bad-input", "resource-not-found"]);

// Consecutive unproductive results after which the NEXT guarded call is stopped.
const CONSECUTIVE_EMPTY_LIMIT = 2;

// SIO-1084: absolute cap on TOTAL unproductive elasticsearch_search calls in one
// sub-agent run, independent of the discovery-aware soft limit. This is the
// termination backstop: even if the LLM permutes distinct args forever and never
// issues a discovery agg (so discoveryRan stays false and the consecutive-empty
// soft stop is suppressed), the run still stops here, well under recursionLimit 40.
// = CONSECUTIVE_EMPTY_LIMIT (2 literal-name empties) + 1 discovery attempt + margin.
const MAX_UNPRODUCTIVE_SEARCHES = 5;

export const LOOP_GUARD_STOP_MESSAGE =
	"No results for this query, and equivalent searches have already returned nothing. " +
	"Stop searching -- do not call this tool again with a similar query. Synthesize your " +
	"findings from the data you have gathered so far and report what you found (including " +
	"that the searched indices/patterns returned no matching documents).";

// SIO-1084: AWS start_query is stopped for a different reason -- a window outside
// retention -- so it needs its own re-anchor instruction, not "no matching documents".
export const AWS_START_QUERY_STOP_MESSAGE =
	"The previous aws_logs_start_query window was rejected as outside the log group's " +
	"retention window, and you have not re-anchored since. Do NOT re-issue the same query. " +
	"Call aws_logs_describe_log_groups first to read retentionInDays and creationTime, then " +
	"re-anchor startTime/endTime to the incident/event timestamp (usually recent) inside " +
	"[now - retentionInDays, now] before calling aws_logs_start_query again.";

export interface LoopGuardState {
	consecutiveEmpty: number;
	seenSignatures: Set<string>;
	// SIO-1084: set once a service.name discovery agg has run; gates the elastic
	// consecutive-empty soft stop so pre-discovery literal-name empties don't
	// terminate before the SOUL discovery step gets to run.
	discoveryRan: boolean;
	// SIO-1084: TOTAL unproductive elasticsearch_search calls this run. Drives the
	// absolute MAX_UNPRODUCTIVE_SEARCHES backstop that guarantees termination even
	// when discoveryRan never flips true (SIO-1029 non-regression).
	unproductiveSearches: number;
	// SIO-1084: set when the last aws_logs_start_query returned a retention/bad-input
	// _error; cleared by an intervening aws_logs_describe_log_groups. While set, the
	// next aws_logs_start_query is short-circuited to force a re-anchor.
	awsStartQueryNeedsReanchor: boolean;
}

export function createLoopGuardState(): LoopGuardState {
	return {
		consecutiveEmpty: 0,
		seenSignatures: new Set<string>(),
		discoveryRan: false,
		unproductiveSearches: 0,
		awsStartQueryNeedsReanchor: false,
	};
}

// SIO-1084: In the ReAct/ToolNode path invoke() receives the full tool-call
// object { id, name, args, type } -- NOT the bare args. Unwrap so the signature
// and discovery detection key on args (the per-call `id` must NOT be hashed, or
// exact-duplicate detection never fires). Bare-args callers (tests, direct
// invoke) pass through unchanged.
export function unwrapCallArgs(arg: unknown): unknown {
	if (arg && typeof arg === "object" && "args" in arg && !Array.isArray(arg)) {
		return (arg as { args: unknown }).args;
	}
	return arg;
}

// Stable signature of a tool call for exact-duplicate detection. Args are
// JSON-normalized with sorted keys so semantically identical calls collide.
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

// SIO-1084: a service.name discovery aggregation is `size: 0` with a terms agg on
// the `service.name` field (the SOUL-mandated discovery step). Permissive on the
// agg name (`by_service` is only an example) but strict on the field + size:0.
// A discovery call is bounded and load-bearing, so the guard never stops it and
// only enables the consecutive-empty stop once one has run.
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
		// Nested aggs (aggs.X.aggs.Y.terms) -- walk one more level.
		const nested = (node as Record<string, unknown>).aggs ?? (node as Record<string, unknown>).aggregations;
		if (aggsTargetServiceName(nested)) return true;
	}
	return false;
}

// SIO-1084: extract the AWS _error kind from a tool result payload, if any.
// Shared with the reporting path so the guard and extractAwsError agree on what
// "an AWS error" is. Returns null when the payload is a normal (non-error) result.
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

function safeStringify(value: unknown): string {
	if (value === undefined || value === null) return "";
	try {
		return JSON.stringify(value) ?? "";
	} catch {
		return String(value);
	}
}

// A result is "unproductive" when it carries no usable data. For elasticsearch_search:
// an explicit empty search ("Total results: 0"), an empty content type, an empty array,
// or a trivially-small string. For aws_logs_start_query: an _error envelope with a
// looping kind (retention-window rejection / wrong group). Kept narrow so real
// (non-empty) results -- including a successful { queryId } -- never trip it.
export function isUnproductiveResult(content: unknown, toolName?: string): boolean {
	if (toolName === "aws_logs_start_query") {
		const kind = awsErrorKind(content);
		return kind !== null && AWS_LOOPING_ERROR_KINDS.has(kind);
	}
	const { shape } = describeToolResult(content);
	if (shape.contentType === "empty") return true;
	if (shape.contentType === "array" && shape.topLevelArrayLen === 0) return true;
	if (shape.contentType === "object" && shape.hitsLen === 0) return true;
	if (shape.contentType === "string") {
		const text = typeof content === "string" ? content : "";
		// SIO-1084: a zero-bucket discovery aggregation renders as
		// "Search results with aggregations (N total hits, ...):" -- NOT "Total
		// results: 0" -- so EMPTY_SEARCH_RE misses it and the empty discovery (the
		// genuine "service absent" signal) would otherwise reset the streak. Treat an
		// aggregation whose every terms agg has no buckets as unproductive too.
		if (EMPTY_SEARCH_RE.test(text)) return true;
		return isEmptyAggregationResult(text);
	}
	return false;
}

// True when the text is an aggregation-only render whose terms aggs returned no
// buckets. Defensive: only trips on the explicit "aggregations" render + a parsed
// JSON body with zero buckets; a parse miss or any non-empty bucket returns false.
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

// Returns true only if at least one terms agg is present AND every present terms
// agg has an empty buckets array. (No aggs at all -> false, don't over-trip.)
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

// Decide BEFORE invoking whether this call should be short-circuited. Trips when
// the exact same (tool, args) call was already seen, OR the consecutive-empty
// budget is exhausted (elastic: only once a discovery agg has run), OR (aws) a
// prior retention rejection has not yet been re-anchored via describe_log_groups.
// Only guarded tools are considered; everything else runs. `arg` is the raw
// tool-call object; it is unwrapped internally.
export function shouldShortCircuit(state: LoopGuardState, toolName: string, signature: string, arg?: unknown): boolean {
	if (!GUARDED_TOOLS.has(toolName)) return false;

	if (toolName === "aws_logs_start_query") {
		if (state.seenSignatures.has(signature)) return true;
		if (state.awsStartQueryNeedsReanchor) return true;
		return false;
	}

	// elasticsearch_search
	// An exact-duplicate call is always a loop -- stop it (including a repeated
	// identical discovery agg).
	if (state.seenSignatures.has(signature)) return true;
	// Absolute termination backstop (SIO-1029 non-regression): once TOTAL
	// unproductive searches hit the hard cap, stop unconditionally -- even a
	// discovery call, and even if discovery never ran. This bounds a permuting LLM
	// that keeps issuing distinct empty queries, which the discovery-aware soft
	// stop below would otherwise never catch.
	if (state.unproductiveSearches >= MAX_UNPRODUCTIVE_SEARCHES) return true;
	// A fresh service.name discovery agg is bounded + load-bearing: below the hard
	// cap, never let the consecutive-empty soft stop block the FIRST one, so the
	// SOUL discovery step can run even after two literal-name empties.
	if (isDiscoveryCall(arg)) return false;
	// Soft stop: after 2 consecutive empties, stop -- but only once discovery has
	// run, so pre-discovery empties don't terminate before the discovery step.
	return state.consecutiveEmpty >= CONSECUTIVE_EMPTY_LIMIT && state.discoveryRan;
}

// SIO-1084: reserve a guarded call's signature BEFORE invoking it. ToolNode can
// dispatch multiple tool calls from one AIMessage concurrently, so two identical
// guarded calls could both pass shouldShortCircuit before either reaches
// recordResult -- reserving here makes the second one a detected duplicate. Adding
// to the Set is idempotent, so recordResult re-adding it is a no-op.
export function reserveSignature(state: LoopGuardState, toolName: string, signature: string): void {
	if (!GUARDED_TOOLS.has(toolName)) return;
	state.seenSignatures.add(signature);
}

// Update state AFTER a real (non-short-circuited) call completes. Records the
// signature for duplicate detection, tracks the empty streak, marks discovery,
// and manages the AWS re-anchor flag. `arg` is the raw tool-call object.
export function recordResult(
	state: LoopGuardState,
	toolName: string,
	signature: string,
	content: unknown,
	arg?: unknown,
): void {
	// Observe (but don't guard) describe_log_groups: it clears the re-anchor gate.
	if (toolName === AWS_DESCRIBE_LOG_GROUPS) {
		state.awsStartQueryNeedsReanchor = false;
		return;
	}
	if (!GUARDED_TOOLS.has(toolName)) return;

	state.seenSignatures.add(signature);

	if (toolName === "aws_logs_start_query") {
		state.awsStartQueryNeedsReanchor = isUnproductiveResult(content, toolName);
		return;
	}

	// elasticsearch_search
	if (isDiscoveryCall(arg)) state.discoveryRan = true;
	if (isUnproductiveResult(content, toolName)) {
		state.consecutiveEmpty += 1;
		state.unproductiveSearches += 1;
	} else {
		state.consecutiveEmpty = 0;
	}
}

export function isGuardedTool(toolName: string): boolean {
	return GUARDED_TOOLS.has(toolName);
}

// SIO-1084: the instrumentation records describe_log_groups even though it's not
// guarded, so recordResult must be called for it too. This predicate tells the
// call site when to invoke recordResult.
export function isObservedTool(toolName: string): boolean {
	return GUARDED_TOOLS.has(toolName) || toolName === AWS_DESCRIBE_LOG_GROUPS;
}

// SIO-1084: select the stop message for a guarded tool.
export function stopMessageFor(toolName: string): string {
	return toolName === "aws_logs_start_query" ? AWS_START_QUERY_STOP_MESSAGE : LOOP_GUARD_STOP_MESSAGE;
}

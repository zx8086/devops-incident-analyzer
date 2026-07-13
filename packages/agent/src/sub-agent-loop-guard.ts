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

// SIO-1086: the stop must NOT steer the LLM to "absent" when a discovery agg already
// surfaced a candidate service.name -- the data exists under that discovered name, and
// the earlier version's "report ... no matching documents" wording converted a discovery
// hit into a false "not shipping". Only permit an "absent" conclusion when discovery
// surfaced no matching service at all.
export const LOOP_GUARD_STOP_MESSAGE =
	"No results for this query, and equivalent searches have already returned nothing. " +
	"Stop searching -- do not call this tool again with a similar query. " +
	"If a discovery step surfaced a candidate service name you have not confirmed, treat " +
	"the service as present under that name. Synthesize your findings from the data you " +
	"have gathered so far: report the discovered service.name and what you found, or -- " +
	"only when discovery surfaced no matching service at all -- report that the searched " +
	"indices/patterns returned no matching documents.";

// SIO-1089: when the unproductive searches all carried a bounded @timestamp window,
// the zero is far more likely a too-narrow window on a CHRONIC (recurs for days/weeks,
// low frequency) error than a wrong service name. Before the LLM permutes into
// discovery or concludes absence, steer it to WIDEN the window and retry once. This
// message is emitted in place of the standard stop when a time-window widen has not
// yet been attempted (see timeWindowWidened); the widened retry itself is allowed
// through by a one-shot grant so the guard does not block the recovery it just asked for.
export const LOOP_GUARD_WIDEN_WINDOW_MESSAGE =
	"No results, and equivalent searches have already returned nothing -- but every one " +
	"of these queries carried a narrow `@timestamp` window. A chronic error (recurring for " +
	"days/weeks at low frequency) is easily missed by a 1-hour or single-day slice. Do NOT " +
	"conclude the service is absent and do NOT run a discovery aggregation yet. Instead, " +
	"re-run the SAME query exactly once with only the time window widened: set the " +
	"`@timestamp` range `gte` to `now-7d` (and drop or widen `lte`). If that widened query " +
	"still returns nothing, THEN fall back to discovery or report no matching documents.";

// SIO-1089: the load-bearing fix for trailing-empty amnesia. When a run has ALREADY
// latched a valid result (non-empty + concerns the focus service) but then wandered
// into empties, the LLM's last-observed context is "empty" and it wrongly concludes
// absence. This stop message injects the latched result BACK so the LLM's final
// context is the WIN, not the trailing empty. Rendered with the latched service/count/
// window by latchedStopMessage(); this constant is the fixed lead-in for tests/greppability.
export const LOOP_GUARD_LATCHED_STOP_LEAD =
	"You have ALREADY retrieved valid data this run. Stop searching and use it as your finding.";

// Build the latched-result stop message from the best result on record.
export function latchedStopMessage(best: BestResult): string {
	const svc = best.serviceName ? ` for service.name "${best.serviceName}"` : "";
	const win = best.windowLabel ? ` over the window ${best.windowLabel}` : "";
	return (
		`${LOOP_GUARD_LATCHED_STOP_LEAD} A prior query already returned ${best.hitCount} matching ` +
		`document(s)${svc}${win}. Do NOT call this tool again and do NOT conclude the service or error is ` +
		"absent -- that earlier result is your answer. Synthesize your findings from it now: report the " +
		"service.name, the matching count, and the timestamps you already observed."
	);
}

// SIO-1084: AWS start_query is stopped for a different reason -- a window outside
// retention -- so it needs its own re-anchor instruction, not "no matching documents".
export const AWS_START_QUERY_STOP_MESSAGE =
	"The previous aws_logs_start_query window was rejected as outside the log group's " +
	"retention window, and you have not re-anchored since. Do NOT re-issue the same query. " +
	"Call aws_logs_describe_log_groups first to read retentionInDays and creationTime, then " +
	"re-anchor startTime/endTime to the incident/event timestamp (usually recent) inside " +
	"[now - retentionInDays, now] before calling aws_logs_start_query again.";

// SIO-1089: the best (validated) elasticsearch_search result latched so far. A result
// latches only when it is non-empty AND -- if the query filtered on a service.name --
// concerns that service (validity != mere non-emptiness, so a wrong-service/stale hit
// is never latched and mis-reported). Carries just enough to render latchedStopMessage.
export interface BestResult {
	hitCount: number;
	serviceName?: string;
	windowLabel?: string;
}

export interface LoopGuardState {
	consecutiveEmpty: number;
	seenSignatures: Set<string>;
	// SIO-1089: the best validated result on record (undefined until one latches). Once
	// set, the stop path injects it back into the LLM's context so a trailing empty can
	// never flip a confirmed hit to "absent" (trailing-empty amnesia). Replaced only by a
	// strictly-better result (more hits).
	bestResult?: BestResult;
	// SIO-1089: set true once at least one unproductive elasticsearch_search carried a
	// bounded @timestamp window AND no wider retry has run yet -- gates the widen-window
	// stop message. Cleared once a widened (window-relaxed) retry has been observed so we
	// don't loop asking to widen forever.
	timeWindowWidened: boolean;
	// SIO-1089: one-shot grant, mirroring postDiscoveryRequeryAllowed. When the guard has
	// asked the LLM to widen the window, the widened retry is a plain (non-discovery)
	// search that the soft stop would otherwise kill -- allow exactly one through.
	widenRetryAllowed: boolean;
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
	// SIO-1086: one-shot grant. A PRODUCTIVE discovery agg (returned service.name
	// buckets) means the agent just learned the real name and must be allowed exactly
	// one non-discovery STEP-1 re-query against that discovered name -- even if the
	// consecutive-empty soft stop is otherwise armed. Set when a productive discovery
	// runs; consumed by the next non-discovery elasticsearch_search that reaches the
	// soft stop. Prevents the guard from blocking the very recovery the discovery
	// enabled (the false-"absent" trap). Bounded by MAX_UNPRODUCTIVE_SEARCHES.
	postDiscoveryRequeryAllowed: boolean;
}

export function createLoopGuardState(): LoopGuardState {
	return {
		consecutiveEmpty: 0,
		seenSignatures: new Set<string>(),
		bestResult: undefined,
		timeWindowWidened: false,
		widenRetryAllowed: false,
		discoveryRan: false,
		unproductiveSearches: 0,
		awsStartQueryNeedsReanchor: false,
		postDiscoveryRequeryAllowed: false,
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

// SIO-1089: does this elasticsearch_search query carry a bounded @timestamp range?
// A `range` filter on @timestamp with a `gte`/`from`/`gt` bound is "time-bounded".
// Used to decide whether a zero result is likely a too-narrow window (widen-on-empty)
// vs a genuinely absent service. Walks the query object for any `range["@timestamp"]`.
export function hasTimeWindow(arg: unknown): boolean {
	const args = unwrapCallArgs(arg);
	if (!args || typeof args !== "object") return false;
	const query = (args as Record<string, unknown>).query;
	return queryHasTimestampRange(query);
}

function queryHasTimestampRange(node: unknown): boolean {
	if (!node || typeof node !== "object") return false;
	if (Array.isArray(node)) return node.some(queryHasTimestampRange);
	const obj = node as Record<string, unknown>;
	const range = obj.range;
	if (range && typeof range === "object") {
		const ts = (range as Record<string, unknown>)["@timestamp"];
		if (ts && typeof ts === "object") {
			const b = ts as Record<string, unknown>;
			// A lower bound is what makes a window "narrow"; an open-ended `lte`-only
			// filter isn't the too-narrow case we widen for.
			if (b.gte !== undefined || b.gt !== undefined || b.from !== undefined) return true;
		}
	}
	for (const v of Object.values(obj)) {
		if (queryHasTimestampRange(v)) return true;
	}
	return false;
}

// SIO-1089: the service.name a query filters on (term/match on service.name inside the
// query), or undefined if none. A latched result is only valid when the query it came
// from was scoped to a service -- so we never latch a broad/global hit as "the service's
// data". Returns the first service.name term/match value found.
export function serviceNameFilter(arg: unknown): string | undefined {
	const args = unwrapCallArgs(arg);
	if (!args || typeof args !== "object") return undefined;
	return findServiceNameValue((args as Record<string, unknown>).query);
}

function findServiceNameValue(node: unknown): string | undefined {
	if (!node || typeof node !== "object") return undefined;
	if (Array.isArray(node)) {
		for (const item of node) {
			const v = findServiceNameValue(item);
			if (v !== undefined) return v;
		}
		return undefined;
	}
	const obj = node as Record<string, unknown>;
	for (const clause of ["term", "match", "match_phrase"] as const) {
		const c = obj[clause];
		if (c && typeof c === "object") {
			const sn = (c as Record<string, unknown>)["service.name"];
			if (typeof sn === "string") return sn;
			if (sn && typeof sn === "object") {
				const val = (sn as Record<string, unknown>).value ?? (sn as Record<string, unknown>).query;
				if (typeof val === "string") return val;
			}
		}
	}
	for (const v of Object.values(obj)) {
		const found = findServiceNameValue(v);
		if (found !== undefined) return found;
	}
	return undefined;
}

// SIO-1089: parse the hit count out of an elastic search render ("Total results: N ...").
// Returns 0 when unparseable so an unknown-shape result never latches as a phantom win.
const TOTAL_RESULTS_RE = /Total results:\s*(\d+)/i;
export function extractHitCount(content: unknown): number {
	const asText = typeof content === "string" ? content : (coalesceTextBlocks(content) ?? "");
	const m = TOTAL_RESULTS_RE.exec(asText);
	if (m?.[1]) return Number.parseInt(m[1], 10);
	// Non-empty array/hits shape with no explicit count -> treat as >=1 so a real hit latches.
	const { shape } = describeToolResult(asText || content);
	if (shape.contentType === "array" && (shape.topLevelArrayLen ?? 0) > 0) return shape.topLevelArrayLen ?? 1;
	if (shape.contentType === "object" && (shape.hitsLen ?? 0) > 0) return shape.hitsLen ?? 1;
	return 0;
}

// SIO-1089: a short human label of the @timestamp window used, for the latched message.
// Best-effort: pulls gte/lte if present. Undefined when no window filter.
export function windowLabel(arg: unknown): string | undefined {
	const args = unwrapCallArgs(arg);
	if (!args || typeof args !== "object") return undefined;
	const bound = findTimestampBounds((args as Record<string, unknown>).query);
	if (!bound) return undefined;
	const gte = bound.gte ?? bound.gt ?? bound.from;
	const lte = bound.lte ?? bound.lt ?? bound.to;
	if (gte !== undefined && lte !== undefined) return `${gte} to ${lte}`;
	if (gte !== undefined) return `${gte} onward`;
	return undefined;
}

function findTimestampBounds(node: unknown): Record<string, unknown> | undefined {
	if (!node || typeof node !== "object") return undefined;
	if (Array.isArray(node)) {
		for (const item of node) {
			const b = findTimestampBounds(item);
			if (b) return b;
		}
		return undefined;
	}
	const obj = node as Record<string, unknown>;
	const range = obj.range;
	if (range && typeof range === "object") {
		const ts = (range as Record<string, unknown>)["@timestamp"];
		if (ts && typeof ts === "object") return ts as Record<string, unknown>;
	}
	for (const v of Object.values(obj)) {
		const b = findTimestampBounds(v);
		if (b) return b;
	}
	return undefined;
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

// SIO-1086: the elastic MCP renders a search/agg result as an ARRAY of MCP text
// content blocks ([{type:"text",text:"..."},{type:"text",text:"{json}"}]), and
// @langchain/mcp-adapters delivers that array RAW on ToolMessage.content -- the
// instrumentation passes it to recordResult without normalizeToolContent. So the
// string-only empty-agg detection (isEmptyAggregationResult) never ran on the real
// wire path (SIO-1084's fix was dead code on production; only its string-form tests
// exercised it). Coalesce a text-block array back to the string it logically is so
// the string checks below apply. Non-text-block arrays return null (real empty
// array / non-elastic shape) and keep the existing len===0 handling.
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

// A result is "unproductive" when it carries no usable data. For elasticsearch_search:
// an explicit empty search ("Total results: 0"), an empty content type, an empty array,
// or a zero-bucket aggregation. For aws_logs_start_query: an _error envelope with a
// looping kind (retention-window rejection / wrong group). Kept narrow so real
// (non-empty) results -- including a successful { queryId } and a data-bearing agg --
// never trip it.
export function isUnproductiveResult(content: unknown, toolName?: string): boolean {
	if (toolName === "aws_logs_start_query") {
		const kind = awsErrorKind(content);
		return kind !== null && AWS_LOOPING_ERROR_KINDS.has(kind);
	}
	// SIO-1086: the elastic agg arrives as an array of MCP text blocks on the real wire
	// path; coalesce it back to the string it logically is so the string-based empty-agg
	// detection (below) runs on it instead of falling through to the array-len check
	// (which only catches a truly empty array, missing a zero-bucket agg render). A
	// data-bearing agg stays productive; a zero-bucket agg is correctly unproductive.
	const coalesced = coalesceTextBlocks(content);
	const asText = typeof content === "string" ? content : coalesced;
	if (typeof asText === "string") {
		if (asText.length === 0) return true;
		if (EMPTY_SEARCH_RE.test(asText)) return true;
		if (isEmptyAggregationResult(asText)) return true;
		// Fall through to the shape checks so a stringified empty array/object
		// ("[]", {hits:{hits:[]}}) is still caught -- describeToolResult parses `asText`.
	}
	const { shape } = describeToolResult(asText ?? content);
	if (shape.contentType === "empty") return true;
	if (shape.contentType === "array" && shape.topLevelArrayLen === 0) return true;
	if (shape.contentType === "object" && shape.hitsLen === 0) return true;
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
	// SIO-1086: a productive discovery agg surfaced the real service.name; the SOUL
	// mandates re-running STEP 1 with that discovered name. That re-query is a plain
	// (non-discovery) search, so without this it would be killed by the soft stop
	// below -- the exact false-"absent" trap. Allow exactly one such re-query
	// (consumed here); the hard MAX_UNPRODUCTIVE_SEARCHES cap above still bounds the run.
	if (state.postDiscoveryRequeryAllowed) {
		state.postDiscoveryRequeryAllowed = false;
		return false;
	}
	// SIO-1089: after an empty time-bounded search we asked the LLM to WIDEN the window.
	// The widened retry is a plain (non-discovery, non-duplicate) search that the soft
	// stop below would otherwise kill. Allow exactly one widened retry through (consumed
	// here) so the guard doesn't block the recovery it just requested. The hard
	// MAX_UNPRODUCTIVE_SEARCHES cap above still bounds the run.
	if (state.widenRetryAllowed) {
		state.widenRetryAllowed = false;
		state.timeWindowWidened = true;
		return false;
	}
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
	const wasDiscovery = isDiscoveryCall(arg);
	if (wasDiscovery) state.discoveryRan = true;
	const unproductive = isUnproductiveResult(content, toolName);
	if (unproductive) {
		state.consecutiveEmpty += 1;
		state.unproductiveSearches += 1;
		// SIO-1089: widen-on-empty signal handling -- ONLY for non-discovery searches (a
		// discovery agg has no @timestamp window and must never touch the widen state, or
		// it would falsely mark the window "already widened"). For a real search:
		// hasTimeWindow(arg) distinguishes "0 in a narrow slice" (arm the widen retry) from
		// "0 with no window at all" i.e. an already-widened query (record that widening
		// didn't help, so the stop message stops asking to widen).
		if (!wasDiscovery) {
			if (hasTimeWindow(arg) && !state.widenRetryAllowed && !state.timeWindowWidened) {
				state.widenRetryAllowed = true;
			} else if (!hasTimeWindow(arg)) {
				state.timeWindowWidened = true;
			}
		}
	} else {
		state.consecutiveEmpty = 0;
		// SIO-1089: latch this as the best result when it is VALID -- non-empty AND the
		// query was scoped to a service.name (so we never latch a broad/global hit as the
		// service's data). Replace an existing latch only when strictly better (more hits).
		const svc = serviceNameFilter(arg);
		if (!wasDiscovery && svc !== undefined) {
			const hitCount = extractHitCount(content);
			if (hitCount > 0 && (state.bestResult === undefined || hitCount > state.bestResult.hitCount)) {
				state.bestResult = { hitCount, serviceName: svc, windowLabel: windowLabel(arg) };
			}
		}
		// SIO-1086: a discovery agg that RETURNED buckets means the agent now has the
		// real service.name -- grant it one guaranteed non-discovery STEP-1 re-query
		// against that name, so the soft stop can't block the recovery the discovery
		// enabled. Only productive discoveries grant it (an empty discovery is the
		// genuine "absent" signal and must not extend the budget).
		if (wasDiscovery) state.postDiscoveryRequeryAllowed = true;
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

// SIO-1084/1089: select the stop message for a guarded tool. Result-aware for elastic:
//  1. a latched valid result wins -- inject it back so the LLM's last context is the WIN,
//     never a trailing empty (the trailing-empty-amnesia fix), and
//  2. otherwise, if the empties were time-bounded and no widened retry has run yet, steer
//     to WIDEN the window before concluding absence,
//  3. otherwise the standard discovery-aware "no matching documents" stop.
export function stopMessageFor(toolName: string, state?: LoopGuardState): string {
	if (toolName === "aws_logs_start_query") return AWS_START_QUERY_STOP_MESSAGE;
	if (state?.bestResult) return latchedStopMessage(state.bestResult);
	if (state && !state.timeWindowWidened && state.widenRetryAllowed) return LOOP_GUARD_WIDEN_WINDOW_MESSAGE;
	return LOOP_GUARD_STOP_MESSAGE;
}

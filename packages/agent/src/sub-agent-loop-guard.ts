// packages/agent/src/sub-agent-loop-guard.ts

import { matchesFocus } from "@devops-agent/shared";
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

// Tools with BESPOKE rulesets. SIO-1232: every other tool now gets the generic guard below --
// previously an unlisted tool was completely unguarded, which is how gitlab made 97 tool calls
// (dozens of them gitlab_search returning a bare `[]`) before the 6-minute wall stopped it.
const GUARDED_TOOLS = new Set<string>(["elasticsearch_search", "aws_logs_start_query"]);

// SIO-1232: generic termination guarantees for every non-bespoke tool.
// MAX_UNPRODUCTIVE_PER_TOOL bounds one tool that keeps coming back empty with permuted args;
// MAX_UNPRODUCTIVE_PER_RUN is the backstop for a permuter that rotates tool NAMES instead.
const MAX_UNPRODUCTIVE_PER_TOOL = 3;
const MAX_UNPRODUCTIVE_PER_RUN = 8;

export const GENERIC_LOOP_GUARD_STOP_MESSAGE =
	"This exact call was already made, or this tool has returned nothing useful several times in a " +
	"row. Do not call it again with these or similar arguments. Synthesize your findings from the " +
	"data you already have, and report what you could not determine as an un-queried gap.";

const AWS_DESCRIBE_LOG_GROUPS = "aws_logs_describe_log_groups";

// SIO-1159: a successful-but-empty CloudWatch query carries no _error, so the
// SIO-1141 re-anchor machinery never fires on it -- run 270378e0 queried a 24h
// window that silently missed a 2-day-old incident. Track consecutive
// Complete-with-0-rows aws_logs_get_query_results and emit one-shot widen advice.
const AWS_GET_QUERY_RESULTS = "aws_logs_get_query_results";
const AWS_EMPTY_RESULTS_ADVICE_THRESHOLD = 2;

// SIO-1232: the two AWS protocol/recovery tools are exempt from EVERY generic rule, not just the
// duplicate check.
//   - aws_logs_get_query_results MUST be re-polled with the SAME queryId while status is
//     Running/Scheduled (the AWS RULES.md protocol prescribes it, and the SIO-1159 consecutive-empty
//     advice above depends on the repeat).
//   - aws_logs_describe_log_groups is the REQUIRED recovery call after a rejected
//     aws_logs_start_query window (SIO-1141 re-anchor); blocking it strands that flow.
//
// CodeRabbit (PR #482) caught that an earlier version exempted these from the duplicate check only,
// so the run-wide backstop could still block them. Neither tool can CONTRIBUTE to totalUnproductive
// -- recordResult early-returns for both before the generic accounting -- so being blocked BY a
// counter they cannot raise is incoherent. Worse, the trigger is another tool's runaway, i.e.
// exactly the scenario this guard exists to bound: a gitlab spam reaching MAX_UNPRODUCTIVE_PER_RUN
// would have silently killed the CloudWatch poll mid-query.
// Declared here (not beside the other generic constants) because it references the two names
// initialised just above -- referencing them earlier would hit the const TDZ.
const GENERIC_GUARD_EXEMPT_TOOLS = new Set<string>([AWS_GET_QUERY_RESULTS, AWS_DESCRIBE_LOG_GROUPS]);

const AWS_ECS_LIST_CLUSTERS = "aws_ecs_list_clusters";
const AWS_ECS_LIST_SERVICES = "aws_ecs_list_services";

// SIO-1268: the tools that constitute the FOCUS-SERVICE hunt. Once a COMPLETE, clean ECS
// enumeration of this estate has shown the focus service is not deployed here, continuing down
// this chain can only re-confirm a negative. On run 2445908e the estate WITHOUT the service spent
// iterations ~15..59 doing exactly that -- 191s and 78 messages, against 117s and 29 messages for
// the estate that HAD it.
//
// aws_logs_get_query_results and aws_logs_describe_log_groups are deliberately ABSENT. They are
// GENERIC_GUARD_EXEMPT_TOOLS (see above) because PR #482 established that blocking an in-flight
// CloudWatch poll strands a query mid-flight. Blocking aws_logs_start_query alone is sufficient:
// no new queries start, so the poll loop drains on its own. Nothing outside this set is blocked --
// account-level work (alarms, health events, the SIO-834 governance inventory path) is unaffected,
// because absence of the FOCUS service says nothing about the rest of the estate.
const AWS_ABSENCE_BLOCKED_TOOLS = new Set<string>([
	"aws_logs_start_query",
	AWS_ECS_LIST_CLUSTERS,
	AWS_ECS_LIST_SERVICES,
	"aws_ecs_describe_services",
	"aws_ecs_list_tasks",
	"aws_ecs_describe_tasks",
	"aws_ecs_describe_task_definition",
]);

// SIO-1162: an invalid/expired queryId polled via aws_logs_get_query_results returns a
// bad-input _error ("The provided queryId = ... is invalid"). A queryId is estate/region
// scoped and short-lived: it only works when polled with the SAME estate passed to
// aws_logs_start_query, and it expires. Re-polling the same id never succeeds, so we emit a
// one-shot corrective hint telling the agent to re-issue start_query for the SAME estate and
// poll the fresh id. resource-not-found is included in case an expired id ever surfaces that
// way rather than as bad-input.
const AWS_INVALID_QUERY_ID_KINDS = new Set<string>(["bad-input", "resource-not-found"]);

// An empty elasticsearch_search renders as "Total results: 0, showing 0 ...".
const EMPTY_SEARCH_RE = /Total results:\s*0\b/i;

// SIO-1259: a SHORT PROSE "nothing found" answer carries no data, but describeToolResult reports it
// as contentType "string" and isUnproductiveResult had no string branch -- so it was PRODUCTIVE and
// reset the tool's streak on every miss. The concrete case is the 0-hit blob-search branch of
// packages/mcp-server-gitlab/src/tools/proxy/index.ts, which returns
// `No code matches found for "${search}" in project ${projectId}`: 40 fixed bytes + search +
// project_id, which is exactly the 72- and 78-byte gitlab_search results in run
// cbada913-d22f-4618-826b-0c4c38fd8956. Couchbase ("No results found for this query.") and elastic
// ILM ("No indices found matching pattern: ...") emit the same shape.
//
// Two clauses, and BOTH are load-bearing:
//   1. Anchored at the START, with a lazy span that cannot cross a "." or a newline. This is what
//      keeps "No parameters specified. Returning node names only. Use {metric: ...}" -- the
//      elasticsearch_get_nodes_info HEADER block that PRECEDES a real payload -- productive: no
//      keyword appears before its first period.
//   2. A byte ceiling, so the opener must BE the whole payload. A multi-block result that opens
//      "No exact matches found for X" and then lists 20 hits is productive; without the ceiling,
//      coalesceTextBlocks would hand us that whole string and clause 1 alone would condemn it.
//
// The keyword list is deliberately narrow. "No searches provided" and "No metric specified" are NOT
// matched -- adding `provided|specified` would swallow the nodes_info/nodes_stats headers above,
// and those two are input-validation errors of no loop-guard interest.
//
// A pure length threshold was rejected: it cannot separate these from `Exists: true` (12 bytes,
// elastic index_exists/document_exists), "Server and database are healthy" (31, capella_ping) or
// "Found 7 distinct sources" -- all short, definitive, data-bearing answers.
const EMPTY_PROSE_MAX_BYTES = 400;
const EMPTY_PROSE_RE =
	/^\s*no\b[^.\n]{0,120}?\b(?:found|match|matches|matched|results?|records?|items?|documents?|hits?|entries)\b/i;

function isEmptyProseResult(text: string): boolean {
	if (Buffer.byteLength(text, "utf8") > EMPTY_PROSE_MAX_BYTES) return false;
	// Gate on contentType "string": a JSON payload that happens to contain the phrase must be judged
	// on its parsed shape by the array/object branches, never on its text.
	if (describeToolResult(text).shape.contentType !== "string") return false;
	return EMPTY_PROSE_RE.test(text);
}

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

export const AWS_INVALID_QUERY_ID_ADVICE =
	"[loop-guard advice] aws_logs_get_query_results rejected the queryId as invalid. A queryId is " +
	"estate/region-scoped and short-lived: it only works when polled with the SAME estate you passed " +
	"to aws_logs_start_query, and it expires. Do NOT re-poll this id. Re-issue aws_logs_start_query " +
	"for the SAME estate and log group, then poll the NEW queryId it returns.";

// SIO-1268: emitted ONLY when awsEcsAbsenceProven() is true, i.e. a COMPLETE, error-free ECS
// enumeration of this estate matched nothing. Phrased to produce the SIO-1149 negative FINDING
// (aws-agent/RULES.md "Cross-Estate Absence Is a Finding") rather than a gap: that prose already
// required this and the model ignored it, so the stop restates it at the point of decision, with
// the evidence already in hand.
export const AWS_SERVICE_ABSENT_STOP_MESSAGE =
	"Enumeration of this estate is COMPLETE and conclusive: every ECS cluster was listed, every " +
	"cluster's services were listed, every continuation page was walked, no call errored, and NONE " +
	"of the returned cluster or service names match the focus service. That is a definitive " +
	"negative finding, not a gap -- searching log groups or running CloudWatch Insights queries " +
	"cannot change it, because an empty query result cannot distinguish absence from a bad window. " +
	"Do NOT call this tool again. Write your findings NOW, stating that the focus service is not " +
	"deployed in this estate, and cite the enumeration evidence (how many clusters you walked and " +
	"which service names you did see). Do not phrase this as 'could not be located', 'unconfirmed', " +
	"or an un-queried gap.";

export const AWS_START_QUERY_STOP_MESSAGE =
	"The previous aws_logs_start_query window was rejected as outside the log group's " +
	"retention window, and you have not re-anchored since. Do NOT re-issue the same query. " +
	"Call aws_logs_describe_log_groups first to read retentionInDays and creationTime, then " +
	"re-anchor startTime/endTime to the incident/event timestamp (usually recent) inside " +
	"[now - retentionInDays, now] before calling aws_logs_start_query again.";

// SIO-1268: per-estate ECS enumeration ledger. Each AWS estate is an INDEPENDENT runSubAgent
// invocation with its own LoopGuardState (sub-agent.ts AWS fan-out), so this is already correctly
// scoped to one estate -- no estate key is needed.
//
// COMPLETENESS is the whole point. A partial enumeration must NEVER early-exit: that would
// suppress a genuine finding, which is strictly worse than the wasted iterations this fixes. Every
// field below exists to make "complete" provable rather than assumed, and the bias is
// one-directional: we would rather waste iterations than hide a real service.
export interface AwsEcsEnumerationState {
	// Off entirely when the flag is off or focus is empty. matchesFocus returns TRUE for an empty
	// focus list (shared/focus-match.ts), so an empty focus would make `matched` vacuously true --
	// safe, but the explicit gate is clearer and cheaper.
	enabled: boolean;
	focusServices: string[];
	// Set when a list_clusters page arrived with NO continuation token and NO _truncated.
	clusterPagesComplete: boolean;
	// Union of cluster NAMES (not ARNs) seen across all list_clusters pages.
	clusters: Set<string>;
	// Cluster names whose list_services reached a final page.
	servicesComplete: Set<string>;
	// A cluster or service name matched the focus -> the service may be here; never exit.
	matched: boolean;
	// Any _error envelope, any _truncated page, any unparseable result, or any loop-guard stop on
	// an ECS list call. Latches ON and is never cleared: once enumeration is known-incomplete for
	// this estate it stays that way, so a later clean re-list cannot resurrect the exit.
	failed: boolean;
	// One-shot, so the decision is logged once rather than on every blocked call.
	exitLogged: boolean;
}

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
	// SIO-1162: set when the last aws_logs_get_query_results returned an invalid/expired
	// queryId (bad-input/resource-not-found _error); consumed (cleared) when the corrective
	// advice is emitted once.
	awsInvalidQueryId: boolean;
	// SIO-1232: generic per-tool and per-run unproductive counters for every non-bespoke tool.
	unproductiveByTool: Map<string, number>;
	totalUnproductive: number;
	// SIO-1268: ECS enumeration ledger driving the "service not deployed in this estate" exit.
	awsEcs: AwsEcsEnumerationState;
}

export interface LoopGuardOptions {
	// SIO-1268: passed from sub-agent.ts, which owns the env read -- this module stays pure (no
	// process.env) and therefore directly unit-testable, matching its current shape.
	awsAbsenceEarlyExit?: boolean;
	focusServices?: string[];
}

export function createLoopGuardState(opts: LoopGuardOptions = {}): LoopGuardState {
	const focusServices = opts.focusServices ?? [];
	return {
		seenSignatures: new Set<string>(),
		unproductiveSearches: 0,
		awsStartQueryNeedsReanchor: false,
		awsStartQueryUnproductive: 0,
		awsEmptyQueryResults: 0,
		awsInvalidQueryId: false,
		unproductiveByTool: new Map<string, number>(),
		totalUnproductive: 0,
		awsEcs: {
			// Defaults keep every existing call site and test compiling and behaving unchanged.
			enabled: opts.awsAbsenceEarlyExit === true && focusServices.length > 0,
			focusServices,
			clusterPagesComplete: false,
			clusters: new Set<string>(),
			servicesComplete: new Set<string>(),
			matched: false,
			failed: false,
			exitLogged: false,
		},
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

// SIO-1162: detect an invalid/expired queryId error on aws_logs_get_query_results. Keyed on
// the resulting _error.kind (bad-input/resource-not-found), which is stable regardless of the
// exact SDK error name AWS uses for the invalid-queryId message.
export function isInvalidQueryIdResult(content: unknown): boolean {
	const kind = awsErrorKind(content);
	return kind !== null && AWS_INVALID_QUERY_ID_KINDS.has(kind);
}

// SIO-1159: one-shot widen advice after N consecutive empty-success results. Consuming
// resets the counter so the advice is appended once, not to every subsequent call.
export function consumeEmptyAwsResultsAdvice(state: LoopGuardState): string | null {
	if (state.awsEmptyQueryResults < AWS_EMPTY_RESULTS_ADVICE_THRESHOLD) return null;
	state.awsEmptyQueryResults = 0;
	return AWS_EMPTY_RESULTS_ADVICE;
}

// SIO-1162: one-shot invalid-queryId advice. Fires on the FIRST invalid-id result (unlike the
// empty-results advice, which needs two consecutive empties -- a single invalid id already
// means every re-poll of it is wasted). Consuming clears the flag so it is appended once.
export function consumeInvalidQueryIdAdvice(state: LoopGuardState): string | null {
	if (!state.awsInvalidQueryId) return null;
	state.awsInvalidQueryId = false;
	return AWS_INVALID_QUERY_ID_ADVICE;
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
		if (isEmptyProseResult(asText)) return true;
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
// SIO-1268: ECS identifiers arrive as ARNs from the list tools
// (arn:aws:ecs:eu-west-1:123:cluster/my-cluster, .../service/my-cluster/my-service), but the
// `cluster` ARG on aws_ecs_list_services may be a SHORT NAME or a full ARN (list-services.ts: "Short
// name or full ARN"). Both sides must reduce to the last path segment or servicesComplete never
// intersects `clusters` and the exit can never fire.
//
// Focus matching uses the extracted NAME, never the ARN: tokenize() splits on [-_.] only
// (shared/focus-match.ts), so a raw ARN yields account-id and region tokens that make matchesFocus
// meaningless.
function ecsLastSegment(arn: string): string {
	const i = arn.lastIndexOf("/");
	return i === -1 ? arn : arn.slice(i + 1);
}

// A page is FINAL only when it carries no continuation token AND was not byte-truncated.
// _truncated Case B (wrap.ts) has NO cursor but still dropped items -- treating it as final would
// be exactly the partial-enumeration false positive this design must not produce.
const ECS_TOKEN_FIELDS = ["nextToken", "NextToken", "Marker", "NextMarker", "PaginationToken"];

function isFinalListPage(obj: Record<string, unknown>): boolean {
	if ("_truncated" in obj) return false;
	for (const field of ECS_TOKEN_FIELDS) {
		const v = obj[field];
		if (typeof v === "string" && v.length > 0) return false;
	}
	return true;
}

function parseEcsListResult(content: unknown): Record<string, unknown> | null {
	// Mirrors isUnproductiveResult's coalescing: AWS MCP results arrive as a string today, but
	// @langchain/mcp-adapters can deliver a raw text-block ARRAY.
	const coalesced = coalesceTextBlocks(content);
	const text = typeof content === "string" ? content : (coalesced ?? safeStringify(content));
	const start = text.indexOf("{");
	if (start === -1) return null;
	try {
		const parsed = JSON.parse(text.slice(start));
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
	} catch {
		return null;
	}
}

// SIO-1268: fold one ECS list result into the ledger. Called from recordResult. Every failure mode
// -- unparseable, _error, truncated page, missing cluster arg -- sets `failed`, which permanently
// disables the exit for this estate.
export function observeEcsListResult(state: LoopGuardState, toolName: string, content: unknown, arg?: unknown): void {
	const e = state.awsEcs;
	if (!e.enabled) return;
	if (toolName !== AWS_ECS_LIST_CLUSTERS && toolName !== AWS_ECS_LIST_SERVICES) return;

	if (awsErrorKind(content) !== null) {
		e.failed = true;
		return;
	}
	const obj = parseEcsListResult(content);
	if (obj === null) {
		e.failed = true;
		return;
	}
	const final = isFinalListPage(obj);
	if ("_truncated" in obj) e.failed = true;

	if (toolName === AWS_ECS_LIST_CLUSTERS) {
		const arns = Array.isArray(obj.clusterArns) ? obj.clusterArns : [];
		for (const a of arns) {
			if (typeof a !== "string") continue;
			const name = ecsLastSegment(a);
			e.clusters.add(name);
			// A cluster NAMED for the focus service is itself evidence of presence.
			if (matchesFocus(name, e.focusServices)) e.matched = true;
		}
		if (final) e.clusterPagesComplete = true;
		return;
	}

	// aws_ecs_list_services
	const arns = Array.isArray(obj.serviceArns) ? obj.serviceArns : [];
	for (const a of arns) {
		if (typeof a !== "string") continue;
		if (matchesFocus(ecsLastSegment(a), e.focusServices)) e.matched = true;
	}
	const args = unwrapCallArgs(arg);
	const cluster = args && typeof args === "object" ? (args as Record<string, unknown>).cluster : undefined;
	if (typeof cluster !== "string" || cluster.length === 0) {
		// Without a cluster arg this page cannot be attributed, so completeness is unprovable.
		// (The schema requires it, so this is defensive.)
		e.failed = true;
		return;
	}
	if (final) e.servicesComplete.add(ecsLastSegment(cluster));
}

// SIO-1268: the exit predicate. Evaluated LAZILY rather than latched at record time, because
// ToolNode runs one AIMessage's tool calls CONCURRENTLY -- the last list_services to resolve is not
// necessarily the one that completes the set.
//
// Every clause is a completeness requirement:
//   failed               -> any error/truncation/guard-stop anywhere in the chain
//   matched              -> the service (or a cluster named for it) IS here
//   clusterPagesComplete -> list_clusters was walked to its final page
//   clusters.size > 0    -> a ZERO-cluster estate is NOT proof. That shape is indistinguishable
//                           from a scoping/permission artifact, and SIO-834 (RULES.md) exists
//                           precisely because an all-empty estate needs the inventory check.
//   every cluster walked -> the miss is estate-wide, not "the 3 clusters it happened to try"
export function awsEcsAbsenceProven(state: LoopGuardState): boolean {
	const e = state.awsEcs;
	if (!e.enabled || e.failed || e.matched) return false;
	if (!e.clusterPagesComplete) return false;
	if (e.clusters.size === 0) return false;
	for (const c of e.clusters) {
		if (!e.servicesComplete.has(c)) return false;
	}
	return true;
}

// Exposed so the instrumentation layer can log the evidence behind the decision exactly once.
export function consumeAbsenceExitLog(
	state: LoopGuardState,
): { clustersEnumerated: number; servicesEnumerated: number; focusServices: string[] } | null {
	if (state.awsEcs.exitLogged) return null;
	state.awsEcs.exitLogged = true;
	return {
		clustersEnumerated: state.awsEcs.clusters.size,
		servicesEnumerated: state.awsEcs.servicesComplete.size,
		focusServices: state.awsEcs.focusServices,
	};
}

export function shouldShortCircuit(state: LoopGuardState, toolName: string, signature: string, arg?: unknown): boolean {
	// SIO-1232: generic guard for every tool without a bespoke ruleset. Previously this returned
	// false immediately for anything outside GUARDED_TOOLS, i.e. no termination guarantee at all.
	if (!GUARDED_TOOLS.has(toolName)) {
		// Protocol/recovery tools bypass EVERY generic rule, including the run-wide backstop --
		// see GENERIC_GUARD_EXEMPT_TOOLS. This must stay the first check in this branch.
		if (GENERIC_GUARD_EXEMPT_TOOLS.has(toolName)) return false;
		// SIO-1268: placed AFTER the exemption so aws_logs_get_query_results and
		// aws_logs_describe_log_groups keep their PR #482 carve-out unconditionally, and BEFORE the
		// duplicate/streak rules because the absence conclusion supersedes them.
		if (AWS_ABSENCE_BLOCKED_TOOLS.has(toolName) && awsEcsAbsenceProven(state)) return true;
		if (state.seenSignatures.has(signature)) return true;
		if ((state.unproductiveByTool.get(toolName) ?? 0) >= MAX_UNPRODUCTIVE_PER_TOOL) return true;
		return state.totalUnproductive >= MAX_UNPRODUCTIVE_PER_RUN;
	}

	if (toolName === "aws_logs_start_query") {
		// SIO-1268: no NEW Insights query once absence is proven. Only start_query is stopped;
		// aws_logs_get_query_results stays exempt above, so any in-flight query still drains.
		if (awsEcsAbsenceProven(state)) return true;
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
	// SIO-1232: reserved for EVERY tool now, so the generic duplicate rule sees concurrent
	// identical calls. Polling tools are exempted at the shouldShortCircuit check rather than
	// here -- recording their signature is harmless and keeps this function branch-free.
	state.seenSignatures.add(signature);
}

// Update state AFTER a real (non-short-circuited) call completes.
export function recordResult(
	state: LoopGuardState,
	toolName: string,
	signature: string,
	content: unknown,
	// SIO-1268: now READ (observeEcsListResult needs the `cluster` arg to attribute a
	// list_services page to its cluster), so it is no longer underscore-prefixed.
	arg?: unknown,
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
		// SIO-1162: an invalid/expired queryId is never also an empty-success; flag it so the
		// corrective advice fires. It resets the consecutive-empty counter (an error is not an
		// empty-success outcome), matching the existing "Complete with rows (or error) resets"
		// contract.
		if (isInvalidQueryIdResult(content)) {
			state.awsInvalidQueryId = true;
			state.awsEmptyQueryResults = 0;
			return;
		}
		// SIO-1159: count consecutive empty-success outcomes. In-flight polls
		// (Running/Scheduled) are neutral; a Complete with rows (or error) resets.
		if (isEmptyAwsQueryResults(content)) {
			state.awsEmptyQueryResults += 1;
		} else if (!isInFlightAwsQueryResults(content)) {
			state.awsEmptyQueryResults = 0;
		}
		return;
	}
	state.seenSignatures.add(signature);

	// SIO-1268: fold ECS list results into the enumeration ledger. No-op for every other tool and
	// when the detector is disabled.
	//
	// Deliberately does NOT alter the SIO-1232 generic accounting below. An empty
	// {"serviceArns":[]} is classified PRODUCTIVE today (describeToolResult sets hitsLen only for
	// Elastic-shaped hits.hits), and that MUST stay true: if empty ECS lists began counting,
	// MAX_UNPRODUCTIVE_PER_TOOL=3 would block list_services on cluster 4 of 7 and complete
	// enumeration -- the precondition of this whole exit -- would become unreachable.
	observeEcsListResult(state, toolName, content, arg);

	// SIO-1232: generic accounting for every tool without a bespoke ruleset. gitlab_search
	// returning a bare `[]` is `bytes: 2` -> contentType "array", topLevelArrayLen 0 ->
	// isUnproductiveResult already returns true for it; the tool was simply never observed.
	if (!GUARDED_TOOLS.has(toolName)) {
		if (isUnproductiveResult(content, toolName)) {
			state.unproductiveByTool.set(toolName, (state.unproductiveByTool.get(toolName) ?? 0) + 1);
			state.totalUnproductive += 1;
		} else {
			// A productive call clears THIS tool's streak (the run-wide total is deliberately not
			// reset -- it is the backstop against a permuter that alternates productive-looking
			// and empty calls across many tools).
			state.unproductiveByTool.set(toolName, 0);
		}
		return;
	}

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

// SIO-1232: every tool is observed now. The cost is one stableStringify of a small args object per
// call; the benefit is that an unguarded tool can no longer run away (gitlab: 97 calls).
export function isObservedTool(_toolName: string): boolean {
	return true;
}

// SIO-1084/1090: select the stop message for a guarded tool. `state` is accepted for a
// stable signature with the call site but is no longer needed to choose the elastic
// message (only one remains).
export function stopMessageFor(toolName: string, state?: LoopGuardState): string {
	// SIO-1268: the absence conclusion supersedes the tool's own stop prose -- "re-anchor your
	// window" is actively wrong advice once the service is known not to be in this estate.
	if (state !== undefined && AWS_ABSENCE_BLOCKED_TOOLS.has(toolName) && awsEcsAbsenceProven(state)) {
		return AWS_SERVICE_ABSENT_STOP_MESSAGE;
	}
	if (toolName === "aws_logs_start_query") return AWS_START_QUERY_STOP_MESSAGE;
	// SIO-1232: LOOP_GUARD_STOP_MESSAGE is elastic-specific (it talks about indices, patterns and
	// the service.name discovery agg), so it must not be handed to a gitlab or kafka tool.
	if (toolName === "elasticsearch_search") return LOOP_GUARD_STOP_MESSAGE;
	return GENERIC_LOOP_GUARD_STOP_MESSAGE;
}

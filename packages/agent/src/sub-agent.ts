// agent/src/sub-agent.ts

import type { ToolDefinition } from "@devops-agent/gitagent-bridge";
import { getAllActionToolNames, matchActionsByKeywords, resolveActionTools } from "@devops-agent/gitagent-bridge";
import { getLogger } from "@devops-agent/observability";
import type { DataSourceResult, ToolError, ToolErrorCategory, ToolErrorKind } from "@devops-agent/shared";
import {
	isRetryableCategory,
	redactPiiContent,
	TOOL_ERROR_KIND_TO_CATEGORY,
	ToolErrorCategorySchema,
	ToolErrorKindSchema,
} from "@devops-agent/shared";
import { dispatchCustomEvent } from "@langchain/core/callbacks/dispatch";
import type { BaseMessage } from "@langchain/core/messages";
import type { RunnableConfig } from "@langchain/core/runnables";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { capSubAgentTimeoutMs, getGraphDeadlineAt } from "./graph-budget.ts";
import { createLlm } from "./llm.ts";
import { getToolsForDataSource, withAwsEstate, withElasticDeployment } from "./mcp-bridge.ts";
import { extractTextFromContent } from "./message-utils.ts";
import { fetchNetworkBaseline, isNetworkBaselineEnabled } from "./network-baseline.ts";
import { buildCachedSystemMessage } from "./prompt-cache.ts";
import { buildSubAgentPrompt, getSkillToolNames, getToolDefinitionForDataSource } from "./prompt-context.ts";
import type { AgentStateType } from "./state.ts";
import { applyContextBudget, getSubAgentContextBudgetBytes } from "./sub-agent-context-budget.ts";
import { buildFocusBlock } from "./sub-agent-focus-block.ts";
import { instrumentTools, type RawToolOutput, TYPED_FINDING_TOOLS } from "./sub-agent-instrumentation.ts";
import {
	getSubAgentStateOutputCapBytes,
	getSubAgentToolCapBytes,
	truncateToolOutput,
} from "./sub-agent-truncate-tool-output.ts";

const logger = getLogger("agent:sub-agent");

// SIO-1227: find the most recent message that actually yields answer text.
//
// queryDataSource used to read `messages.at(-1)` alone, which loses a whole datasource's
// findings in two measured ways:
//   1. Sonnet 5 sometimes ends the ReAct loop with a REASONING-ONLY assistant message (no text
//      block). extractTextFromContent correctly returns "" for it -- reasoning must never leak to
//      the user -- so the caller saw an empty answer.
//   2. On a recursion-limit salvage the final message is a mid-loop AIMessage/ToolMessage rather
//      than a synthesized answer, so the same "" resulted even though earlier turns DID carry
//      the findings the loop had gathered.
// Both were observed in the SIO-1224 acceptance eval (experiment agent-eval-094b203a): one
// elastic run and two truncated gitlab runs returned responseLength 0 after 94-159 seconds of
// real tool work, each reported as status "success".
//
// Walking backwards fixes both: it recovers the last turn that said something. Only assistant
// messages are considered -- a ToolMessage's content is raw tool output, not an answer, and
// splicing that into r.data would feed the aggregator unlabelled JSON.
export function lastTextualResponse(
	messages: Array<{ content: unknown; _getType(): string }>,
): { text: string; index: number } | null {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (!m || m._getType() !== "ai") continue;
		// Trim only to DECIDE emptiness; return the text verbatim. The pre-SIO-1227 code did not
		// trim, so trimming the returned value would be an unrelated behaviour change (and would
		// make the logged responseLength disagree with the extracted content).
		const text = extractTextFromContent(m.content);
		if (text.trim() !== "") return { text, index: i };
	}
	return null;
}

// SIO-1227: the completion contract, extracted so it is directly testable. The invariant that
// matters -- a sub-agent must NEVER report `success` carrying no findings -- previously lived
// inline in queryDataSource, which cannot be unit-tested without mocking createReactAgent, the
// MCP tool layer and prompt-context (the last of which is a known source of cross-file mock
// pollution in this package). Keeping the decision pure means the invariant is asserted directly
// instead of inferred from the walk-back helper's behaviour.
const SALVAGE_NOTE =
	"\n\n[Note: investigation was truncated at the sub-agent recursion limit; the above reflects partial findings.]";

export interface SubAgentOutcome {
	data: string;
	status: "success" | "error";
	error?: string;
}

export function buildSubAgentOutcome(opts: {
	recovered: { text: string; index: number } | null;
	allToolsFailed: boolean;
	truncated: boolean;
	messageCount: number;
	toolErrorCount: number;
}): SubAgentOutcome {
	const { recovered, allToolsFailed, truncated, messageCount, toolErrorCount } = opts;
	const noFindings = recovered === null;
	const baseData = recovered?.text ?? "No response from sub-agent";
	const data = truncated ? `${baseData}${SALVAGE_NOTE}` : baseData;

	// `status` used to be derived from allToolsFailed alone and never consulted the data, so a run
	// that produced nothing usable still reported success -- and alignment counts statuses, not
	// content, so it neither retried nor degraded confidence. An empty result is a failure of this
	// datasource even when its individual tool calls succeeded.
	if (allToolsFailed) {
		return { data, status: "error", error: `All ${toolErrorCount} tool calls failed` };
	}
	if (noFindings) {
		// An error must always carry a reason. With no toolErrors recorded, alignment's isRetryable
		// defaults to retryable, which is what we want -- a re-run may produce a message with text.
		return { data, status: "error", error: `Sub-agent produced no textual findings across ${messageCount} messages` };
	}
	return { data, status: "success" };
}

// SIO-1029: the LangGraph recursion-limit error. When createReactAgent exhausts
// its recursionLimit it throws GraphRecursionError (name === "GraphRecursionError",
// lc_error_code === "GRAPH_RECURSION_LIMIT", message contains "Recursion limit of
// N reached"). The error carries no partial state, so we salvage the accumulated
// messages by streaming (streamMode: "values" -> full state after each step) and
// keeping the last snapshot. Detected by name/marker to avoid importing the class
// (keeps this testable with a plain fake error).
export function isRecursionLimitError(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	if (error.name === "GraphRecursionError") return true;
	return /GRAPH_RECURSION_LIMIT|Recursion limit of \d+ reached/i.test(error.message);
}

interface SubAgentInvokeResult {
	messages: Array<{ content: unknown; name?: string; _getType(): string }>;
	truncated: boolean;
}

// SIO-1029: run the ReAct sub-agent while capturing the latest full-state
// snapshot, so a recursion-limit blow-up still yields the messages gathered so
// far instead of returning null. On normal completion this behaves exactly like
// agent.invoke (returns the final { messages }). On GraphRecursionError it
// returns the last snapshot with truncated=true. Any other error re-throws to
// the existing hard-error catch. `stream` is injected for testing; it may
// return the async iterable directly or a promise of it (agent.stream does the
// latter).
export type SalvageStreamFn = (
	opts: Record<string, unknown>,
) => AsyncIterable<unknown> | Promise<AsyncIterable<unknown>>;

export async function invokeSubAgentWithSalvage(
	stream: SalvageStreamFn,
	opts: Record<string, unknown>,
): Promise<SubAgentInvokeResult> {
	let last: { messages?: unknown[] } | undefined;
	try {
		const iterable = await stream({ ...opts, streamMode: "values" });
		for await (const chunk of iterable) {
			last = chunk as { messages?: unknown[] };
		}
		return {
			messages: (last?.messages ?? []) as SubAgentInvokeResult["messages"],
			truncated: false,
		};
	} catch (error) {
		if (isRecursionLimitError(error) && last?.messages && last.messages.length > 0) {
			return {
				messages: last.messages as SubAgentInvokeResult["messages"],
				truncated: true,
			};
		}
		throw error;
	}
}

// SIO-626: Prevent hung MCP servers from stalling the pipeline indefinitely.
// SIO-697: Default lifted to 6 min (was 5) so deep elastic fan-outs can finish
// within the graph budget without forcing alignment retries to start with no
// runway. Tunable via SUB_AGENT_TIMEOUT_MS env var.
const SUB_AGENT_TIMEOUT_MS_DEFAULT = 360_000;

export function getSubAgentTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
	const raw = env.SUB_AGENT_TIMEOUT_MS;
	if (raw == null || raw === "") return SUB_AGENT_TIMEOUT_MS_DEFAULT;
	const parsed = Number(raw);
	if (!Number.isFinite(parsed) || parsed <= 0) return SUB_AGENT_TIMEOUT_MS_DEFAULT;
	return Math.floor(parsed);
}

// SIO-1232: an alignment retry re-runs from scratch with the same prompt, so it does not need the
// full first-attempt budget -- and letting it take one lets a single datasource eat the entire
// post-fan-out runway (900s budget - 360s first attempt - 120s aggregation reserve = 420s of
// headroom, of which hasRetryBudget only requires 180s). Half the base still clears the p50
// sub-agent completion time comfortably. Override with SUB_AGENT_RETRY_TIMEOUT_MS.
const SUB_AGENT_RETRY_TIMEOUT_RATIO = 0.5;

export function getSubAgentRetryTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
	const raw = env.SUB_AGENT_RETRY_TIMEOUT_MS;
	if (raw != null && raw !== "") {
		const parsed = Number(raw);
		if (Number.isFinite(parsed) && parsed > 0) return Math.floor(parsed);
	}
	return Math.floor(getSubAgentTimeoutMs(env) * SUB_AGENT_RETRY_TIMEOUT_RATIO);
}

// SIO-1232: AbortSignal.timeout rejects with a DOMException named "TimeoutError", but LangGraph may
// re-wrap it on the way out of stream(), so match on name OR text. Exported so alignment.ts shares
// one definition rather than growing a second, divergent regex.
// The bare `abort(?:ed|error)` fallback is word-bounded: without \b it matches INSIDE
// `ECONNABORTED`, so a transient connection abort (which classifyToolError rightly calls
// retryable, alongside ECONNRESET/ECONNREFUSED) would be misread as a self-inflicted sub-agent
// timeout and lose its one legitimate retry. Caught by CodeRabbit on PR #482.
const SUB_AGENT_ABORT_RE = /aborted due to timeout|operation was aborted|signal timed out|\babort(?:ed|error)\b/i;

export function isSubAgentAbort(message: string | undefined, errorName?: string): boolean {
	if (errorName === "TimeoutError" || errorName === "AbortError") return true;
	return message != null && SUB_AGENT_ABORT_RE.test(message);
}

// SIO-689: Trace evidence on the failing pass-4 query showed 13 LLM iterations + 12 tools-node
// executions = 25 graph steps, the LangGraph default. The 33 underlying elasticsearch_* calls were
// legitimate progressive refinement (cross-deployment 5xx triage), not looping. Lift to 40 for
// elastic only (~20 LLM iterations × ~2.75 parallel tools = ~55 tool-call budget). The 5-minute
// SUB_AGENT_TIMEOUT_MS still bounds wall-clock damage on a true loop.
const ELASTIC_RECURSION_LIMIT_DEFAULT = 40;

// SIO-1232: this used to return undefined for every datasource except elastic, and the caller only
// spreads recursionLimit when defined -- so five of the seven sub-agents ran on LangGraph's DEFAULT
// of 25 super-steps with no explicit budget at all. gitlab made 97 tool calls and hit the 6-minute
// wall instead of any limit.
//
// Sizing: LangGraph counts SUPER-STEPS and a ReAct cycle is two of them (agent + tools), so
// limit ~= 2 x maxLlmTurns + 1. Note the `iteration` counter in the logs counts TOOL CALLS, not
// steps -- with ~2-3 parallel calls per tools step the tool-call budget is roughly
// maxLlmTurns x 2.5, which is why 97 calls fit inside a 25-step default.
//
// invokeSubAgentWithSalvage already salvages partial messages on GraphRecursionError, so hitting a
// limit degrades to partial findings, never a hard error.
const SUB_AGENT_RECURSION_LIMIT_DEFAULT = 30;
const RECURSION_LIMIT_BY_DATASOURCE: Record<string, number> = {
	// SIO-689 measured 13 LLM iterations + 12 tools steps on a real cross-deployment 5xx triage.
	elastic: ELASTIC_RECURSION_LIMIT_DEFAULT,
	// Genuinely deep: a CloudWatch Insights poll burns a full cycle per poll, and the network-path
	// / ingress chains are 4-5 sequential hops by design.
	aws: 40,
	// Slow-query triage chains three skills (indexes -> schema -> explain).
	couchbase: 30,
	// Search -> resolve project -> read MR/commits is 4-6 cycles. 97 calls was thrash, not depth.
	gitlab: 24,
	kafka: 24,
	konnect: 24,
	// Two-entry action map; nothing here needs depth.
	atlassian: 20,
};

export function getSubAgentRecursionLimit(dataSourceId: string, env: NodeJS.ProcessEnv = process.env): number {
	const fallback = RECURSION_LIMIT_BY_DATASOURCE[dataSourceId] ?? SUB_AGENT_RECURSION_LIMIT_DEFAULT;
	// SUBAGENT_ELASTIC_RECURSION_LIMIT is kept as a back-compat alias so deployed ops config does
	// not silently stop taking effect when the generic name lands.
	const raw =
		env[`SUBAGENT_RECURSION_LIMIT_${dataSourceId.toUpperCase()}`] ??
		(dataSourceId === "elastic" ? env.SUBAGENT_ELASTIC_RECURSION_LIMIT : undefined);
	if (raw == null || raw === "") return fallback;
	const parsed = Number(raw);
	if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
	return Math.floor(parsed);
}

// Exported for wiring tests (packages/agent/src/wiring-aws.test.ts).
// SIO-756 follow-up: this table duplicates supervisor.ts AGENT_NAMES;
// collapsing them is pre-existing tech debt for a separate ticket.
export const AGENT_NAMES: Record<string, string> = {
	elastic: "elastic-agent",
	kafka: "kafka-agent",
	couchbase: "capella-agent",
	konnect: "konnect-agent",
	gitlab: "gitlab-agent",
	atlassian: "atlassian-agent",
	aws: "aws-agent",
};

const ERROR_PATTERNS: Array<{ category: ToolErrorCategory; patterns: RegExp[] }> = [
	{
		// SIO-1232: LangGraph's ToolNode throws `Tool "X" not found.\n Please fix your mistakes.`
		// when the model calls a tool the 25-tool binder withheld. This is DETERMINISTIC -- the
		// bound tool set is identical on a retry -- but it fell through to the `unknown` default
		// below, which is retryable, so the model kept re-issuing it and alignment re-dispatched
		// the whole sub-agent. Observed live on aws (aws_ecs_list_clusters and four others).
		// MUST be first: /timeout/i in the transient group would otherwise claim a message that
		// happened to mention one.
		// Patterns are matched against the LOWERCASED message (see classifyToolError), so they are
		// written lowercase -- an uppercase literal here would silently never match.
		category: "not-found",
		patterns: [/tool "[^"]+" not found/, /tool `[a-z0-9_]+` not found/],
	},
	{
		category: "auth",
		patterns: [
			/security_exception/i,
			/\b401\b/,
			/\b403\b/,
			/unauthorized/i,
			/forbidden/i,
			/invalid api key/i,
			/authentication/i,
			/access denied/i,
			/oauth refresh chain expired/i,
			/oauth interactive authorization required/i,
		],
	},
	{
		category: "session",
		patterns: [/session not found/i, /session expired/i, /token expired/i, /session_expired/i],
	},
	{
		category: "transient",
		patterns: [
			/timeout/i,
			/econnrefused/i,
			/econnreset/i,
			/rate limit/i,
			/\b429\b/,
			/\b503\b/,
			/circuit_breaking_exception/i,
			/too_many_requests/i,
			/socket hang up/i,
			/no embeddings/i,
			/indexing is still ongoing/i,
		],
	},
];

export function classifyToolError(message: string): { category: ToolErrorCategory; retryable: boolean } {
	const normalized = message.toLowerCase();
	for (const { category, patterns } of ERROR_PATTERNS) {
		if (patterns.some((p) => p.test(normalized))) {
			return { category, retryable: category === "transient" };
		}
	}
	// Unknown errors are retryable by default -- better to retry than silently drop
	return { category: "unknown", retryable: true };
}

// SIO-728: sentinel that the kafka MCP's ResponseBuilder.error appends to the
// human error text when structured upstream fields (hostname, content-type,
// status) are available. extractToolErrors splits on this and parses the
// trailing JSON. Absent sentinel = unchanged behaviour.
const STRUCTURED_SENTINEL = "\n---STRUCTURED---\n";

// SIO-728: pick only the known structured fields off the parsed JSON. Anything
// else (forward-compat additions, junk) is ignored. The structured payload
// must never widen the ToolError shape by accident.
function pickStructuredFields(raw: unknown): {
	hostname?: string;
	upstreamContentType?: string;
	statusCode?: number;
} {
	if (raw == null || typeof raw !== "object") return {};
	const obj = raw as Record<string, unknown>;
	const out: { hostname?: string; upstreamContentType?: string; statusCode?: number } = {};
	if (typeof obj.hostname === "string") out.hostname = obj.hostname;
	if (typeof obj.upstreamContentType === "string") out.upstreamContentType = obj.upstreamContentType;
	if (typeof obj.statusCode === "number" && Number.isInteger(obj.statusCode)) out.statusCode = obj.statusCode;
	return out;
}

// SIO-764: tool message contents are sometimes JSON strings (kafka MCP responses),
// sometimes plain text (upstream nginx 503 pages). Parse when possible; keep raw
// otherwise. The extractFindings node handles either case.
function tryParseJson(s: string): unknown {
	try {
		return JSON.parse(s);
	} catch {
		return s;
	}
}

// SIO-1159: exported for tests. Decides the persisted form of one tool output.
// SIO-1043 caps toolOutputs[].rawJson so checkpoint state stays bounded, but
// typed-finding tools bypass the cap entirely (mirroring the in-flight skip in
// sub-agent-instrumentation.ts): extractFindings parses the persisted rawJson,
// and truncateToolOutput's "text" fallback is NOT structure-preserving -- a
// 500KB elastic "Document ID:" block string capped at 32KB parses to zero
// findings (observed live: ElasticFindingsCard rawCount 0 in run 270378e0).
// Bounded regardless: pruneThreadState resets dataSourceResults every turn.
export function buildPersistedToolOutput(
	toolName: string,
	text: string,
	stateCapBytes: number | null,
): {
	rawJson: unknown;
	capSkippedBytes: number | null;
	truncation: { strategy: string; originalBytes: number; finalBytes: number } | null;
} {
	if (stateCapBytes == null) {
		return { rawJson: tryParseJson(text), capSkippedBytes: null, truncation: null };
	}
	if (TYPED_FINDING_TOOLS.has(toolName)) {
		const bytes = Buffer.byteLength(text, "utf8");
		return {
			rawJson: tryParseJson(text),
			capSkippedBytes: bytes > stateCapBytes ? bytes : null,
			truncation: null,
		};
	}
	const capped = truncateToolOutput(text, stateCapBytes);
	return {
		rawJson: tryParseJson(capped.content),
		capSkippedBytes: null,
		truncation:
			capped.strategy === "none"
				? null
				: { strategy: capped.strategy, originalBytes: capped.originalBytes, finalBytes: capped.finalBytes },
	};
}

// SIO-786: when an MCP tool returns multiple content blocks (e.g. elastic's
// elasticsearch_search emits a summary block + one block per hit),
// @langchain/mcp-adapters delivers them as an array of {type:"text", text:"..."}
// objects on ToolMessage.content. Plain String() of that array yields
// "[object Object],..." — useless for downstream JSON or text-block parsers.
// Normalise to a single string by joining the `text` fields with "\n\n" so the
// extractors see the same shape that a single-block response produces.
// Exported for unit tests.
export function normalizeToolContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		const texts: string[] = [];
		for (const block of content) {
			if (block && typeof block === "object" && "text" in block) {
				const t = (block as { text?: unknown }).text;
				if (typeof t === "string") texts.push(t);
			}
		}
		if (texts.length > 0) return texts.join("\n\n");
	}
	// SIO-1222: this fall-through was a bare String(content). For a plain object, or an array
	// whose blocks carry no `text` field, that produced the literal "[object Object]" this
	// function's own header warns about -- and it was persisted into checkpointed
	// toolOutputs[].rawJson, destroying the payload. Serialize only in that case: probing the
	// String() result keeps every non-lossy legacy outcome exactly as SIO-786 pinned it
	// (empty array -> "", null -> "null", undefined -> "undefined", primitives unchanged).
	// content-ok: ToolMessage result body, not an AIMessage. String() is the intended
	// representation here for everything it does not mangle.
	const stringified = String(content);
	if (!stringified.includes("[object ")) return stringified;
	try {
		// content-ok: serializing the tool-result body is the point -- it preserves the
		// structure the downstream JSON extractors parse.
		return JSON.stringify(content) ?? stringified;
	} catch {
		return stringified;
	}
}

// SIO-1054: the AWS MCP wrap layer returns tool errors as a *successful* payload carrying
// { "_error": { kind, ... } } rather than throwing, so LangGraph sets status="success" and
// the status gate below dropped them -- the _error blob leaked into r.data as model-visible
// text and no toolError was recorded, so SIO-1031 grounding never fired on non-authz AWS
// failures. Map the AWS ToolErrorKind onto the agent's ToolErrorCategory so ONLY a genuine
// authz kind reads as "auth" (which is what the grounding gate keys on).
type AwsErrorKind =
	| "assume-role-denied"
	| "iam-permission-missing"
	| "aws-throttled"
	| "bad-input"
	| "resource-not-found"
	| "aws-server-error"
	| "aws-network-error"
	| "aws-unknown";

const AWS_KIND_TO_CATEGORY: Record<AwsErrorKind, ToolErrorCategory> = {
	"iam-permission-missing": "auth",
	"assume-role-denied": "auth",
	// SIO-1087: a resource that does not exist will NEVER exist on retry -- classify as the
	// non-retryable "not-found" (a routine finding), not "transient". Previously "transient"
	// made the agent re-issue a guessed log-group/resource name that could never resolve.
	"resource-not-found": "not-found",
	"aws-network-error": "transient",
	"aws-server-error": "server-error",
	"aws-throttled": "transient",
	"bad-input": "unknown",
	"aws-unknown": "unknown",
};

// SIO-1054: pull the AWS { _error } payload out of a (status:"success") tool result body.
// Returns null when the content is not an AWS _error envelope, so the caller can fall through
// to the normal status-gated path unchanged.
function extractAwsError(content: unknown): { kind: AwsErrorKind; message: string } | null {
	// content-ok: ToolMessage result body -- the serialized form is what the '"_error"' substring
	// check and the JSON parse below both need; flattening to text would destroy the envelope.
	const raw = typeof content === "string" ? content : JSON.stringify(content ?? "");
	if (!raw.includes('"_error"')) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return null;
	}
	if (parsed == null || typeof parsed !== "object") return null;
	const err = (parsed as { _error?: unknown })._error;
	if (err == null || typeof err !== "object") return null;
	const kind = (err as { kind?: unknown }).kind;
	if (typeof kind !== "string" || !(kind in AWS_KIND_TO_CATEGORY)) return null;
	const awsErrorMessage = (err as { awsErrorMessage?: unknown }).awsErrorMessage;
	const advice = (err as { advice?: unknown }).advice;
	// SIO-1079: a GENUINE CloudWatch Logs retention-window rejection carries the word "retention"
	// in its raw text, which led the aggregator LLM to report "logs expired". It is a QUERY-WINDOW
	// error, not data expiry -- normalize it to an unambiguous, non-"expired" message.
	// SIO-1087: only do this when the raw message ACTUALLY matches the retention text. The old
	// regex also matched the bare token "MalformedQueryException", so a query-STRING syntax error
	// (identical error name, different cause) was overwritten with the retention/re-anchor message
	// too -- destroying the real reason and trapping the agent in a re-anchor loop. Now: a real
	// retention match is normalized; every other MalformedQueryException keeps its real message and
	// prefers the server's `advice` (which wrap.ts already split into "fix the queryString" vs
	// "re-anchor the window").
	const rawMessageText =
		typeof awsErrorMessage === "string"
			? awsErrorMessage
			: typeof advice === "string"
				? advice
				: `AWS tool error: ${kind}`;
	if (RETENTION_WINDOW_ERROR_RE.test(rawMessageText)) {
		return {
			kind: kind as AwsErrorKind,
			message:
				"aws_logs_start_query time window was outside the log group's retention window (MalformedQueryException). " +
				"This is a query-window error, NOT expired or absent data. Re-anchor the window to the incident time and retry.",
		};
	}
	// Non-retention error: surface the server's advice when present (it distinguishes a query
	// SYNTAX error from a window error), else the raw AWS message.
	const message =
		typeof advice === "string" ? advice : typeof awsErrorMessage === "string" ? awsErrorMessage : rawMessageText;
	return { kind: kind as AwsErrorKind, message };
}

// SIO-1087: matches ONLY the genuine CloudWatch Logs retention-window rejection text (NOT the bare
// "MalformedQueryException" token, which also fires for query-syntax errors). This is the sole
// place the retention message is re-anchored; a syntax MalformedQueryException falls through with
// its real message + the server's "fix the queryString" advice intact.
const RETENTION_WINDOW_ERROR_RE = /end date and time is either before the log group|exceeds the log group.*retention/i;

// SIO-1087: read the SHARED cross-server { _error: { kind, category, message, ... } } envelope
// (buildToolErrorEnvelope in @devops-agent/shared) that couchbase/elastic/kafka/konnect/gitlab/
// atlassian now emit. Classification is by the structured `kind`/`category`, never by message regex.
// Returns null when the content is not a shared envelope (falls through to AWS-specific or regex).
// Distinct from extractAwsError: AWS keeps its own reader for the retention-message special-case.
// SIO-1159: brace-balanced extraction of the {"_error":...} object embedded inside a
// wrapper string. Tracks JSON string literals and escapes so braces inside messages
// don't derail the scan. The forward depth-at-position pass finds the brace that
// actually ENCLOSES the "_error" anchor -- a plain lastIndexOf("{") would land on a
// preceding SIBLING key's nested object (e.g. {"meta":{...},"_error":{...}}) and
// silently lose the envelope. Returns the parsed object or null.
function extractEmbeddedErrorObject(raw: string): unknown {
	const anchor = raw.indexOf('"_error"');
	if (anchor === -1) return null;
	const depths: number[] = new Array(raw.length);
	{
		let d = 0;
		let inStr = false;
		let esc = false;
		for (let i = 0; i < raw.length; i++) {
			depths[i] = d;
			const c = raw[i];
			if (inStr) {
				if (esc) esc = false;
				else if (c === "\\") esc = true;
				else if (c === '"') inStr = false;
				continue;
			}
			if (c === '"') inStr = true;
			else if (c === "{") d += 1;
			else if (c === "}") d -= 1;
		}
	}
	const anchorDepth = depths[anchor];
	if (anchorDepth === undefined || anchorDepth < 1) return null;
	let start = -1;
	for (let i = anchor; i >= 0; i--) {
		if (raw[i] === "{" && depths[i] === anchorDepth - 1) {
			start = i;
			break;
		}
	}
	if (start === -1) return null;
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let i = start; i < raw.length; i++) {
		const ch = raw[i];
		if (inString) {
			if (escaped) escaped = false;
			else if (ch === "\\") escaped = true;
			else if (ch === '"') inString = false;
			continue;
		}
		if (ch === '"') inString = true;
		else if (ch === "{") depth += 1;
		else if (ch === "}") {
			depth -= 1;
			if (depth === 0) {
				try {
					return JSON.parse(raw.slice(start, i + 1));
				} catch {
					return null;
				}
			}
		}
	}
	return null;
}

function extractStructuredToolError(content: unknown): {
	category: ToolErrorCategory;
	kind: ToolErrorKind;
	message: string;
	statusCode?: number;
	hostname?: string;
	upstreamContentType?: string;
} | null {
	// content-ok: ToolMessage result body -- the serialized form is what the '"_error"' substring
	// check and the JSON parse below both need; flattening to text would destroy the envelope.
	const raw = typeof content === "string" ? content : JSON.stringify(content ?? "");
	if (!raw.includes('"_error"') || !raw.includes('"kind"')) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		// SIO-1159: an isError:true MCP result reaches us wrapped by the LangChain adapter
		// ("Error: MCP tool 'x' on server 'y' returned an error: {...}\n Please fix your
		// mistakes."), so the whole-string parse fails and every expected outcome (not-found,
		// no-index) fell through to the regex path as "unknown"/degrading -- falsely tripping
		// the tool-error-rate confidence cap (run 270378e0: 10 expected couchbase errors ->
		// 0.59). Recover the embedded envelope instead of giving up.
		parsed = extractEmbeddedErrorObject(raw);
		if (parsed == null) return null;
	}
	if (parsed == null || typeof parsed !== "object") return null;
	const err = (parsed as { _error?: unknown })._error;
	if (err == null || typeof err !== "object") return null;
	const kindResult = ToolErrorKindSchema.safeParse((err as { kind?: unknown }).kind);
	if (!kindResult.success) return null; // not a shared-taxonomy envelope (e.g. AWS bespoke kind)
	const kind = kindResult.data;
	// SIO-1087: REQUIRE the stamped category. buildToolErrorEnvelope ALWAYS stamps it; the AWS
	// bespoke envelope NEVER does. Some AWS kinds (e.g. "bad-input") also exist in the shared kind
	// union, so keying on `kind` alone would let this reader steal an AWS envelope and bypass
	// extractAwsError -- dropping the Fix A syntax-vs-retention message preservation. Gating on a
	// valid `category` cleanly separates a shared envelope from the AWS one. Category is then
	// canonicalized from the kind (the map is the single source of truth), not trusted off the wire.
	const categoryResult = ToolErrorCategorySchema.safeParse((err as { category?: unknown }).category);
	if (!categoryResult.success) return null;
	const category = TOOL_ERROR_KIND_TO_CATEGORY[kind];
	const adviceRaw = (err as { advice?: unknown }).advice;
	const messageRaw = (err as { message?: unknown }).message;
	const message =
		typeof adviceRaw === "string" ? adviceRaw : typeof messageRaw === "string" ? messageRaw : `tool error: ${kind}`;
	const statusCode = (err as { statusCode?: unknown }).statusCode;
	const hostname = (err as { hostname?: unknown }).hostname;
	const upstreamContentType = (err as { upstreamContentType?: unknown }).upstreamContentType;
	return {
		category,
		kind,
		message,
		statusCode: typeof statusCode === "number" ? statusCode : undefined,
		hostname: typeof hostname === "string" ? hostname : undefined,
		upstreamContentType: typeof upstreamContentType === "string" ? upstreamContentType : undefined,
	};
}

// SIO-707: exported for tests. Redacts PII before ToolError.message lands in logs or state.
// SIO-728: parses ---STRUCTURED--- sentinel to populate hostname/upstreamContentType/statusCode
// when the MCP server emitted them. Redaction runs on the human part only -- hostnames in the
// structured JSON would otherwise be scrubbed.
export function extractToolErrors(
	messages: Array<{ _getType(): string; content: unknown; name?: string; status?: string }>,
): ToolError[] {
	const errors: ToolError[] = [];
	for (const msg of messages) {
		if (msg._getType() !== "tool") continue;

		// SIO-1087: capture the SHARED structured { _error: { kind, category } } envelope from any
		// datasource, and the AWS-specific _error envelope, BEFORE the status gate. Both can ride on
		// a status:"success" message (the MCP wrap returns them as a resolved result). Classification
		// is by structured kind/category, never text regex -- so a routine outcome (no-index,
		// not-found) never reads as a malfunction and never masquerades as "auth".
		if (msg.status !== "error") {
			const structured = extractStructuredToolError(msg.content);
			if (structured) {
				errors.push({
					toolName: msg.name ?? "unknown",
					category: structured.category,
					kind: structured.kind,
					message: redactPiiContent(structured.message.slice(0, 500)),
					retryable: isRetryableCategory(structured.category),
					statusCode: structured.statusCode,
					hostname: structured.hostname,
					upstreamContentType: structured.upstreamContentType,
				});
				continue;
			}
			const awsErr = extractAwsError(msg.content);
			if (awsErr) {
				const category = AWS_KIND_TO_CATEGORY[awsErr.kind];
				errors.push({
					toolName: msg.name ?? "unknown",
					category,
					message: redactPiiContent(awsErr.message.slice(0, 500)),
					retryable: isRetryableCategory(category),
				});
			}
			continue;
		}

		// SIO-1087: a shared envelope can also arrive on a status:"error" message (a server that
		// throws AND serializes the envelope). Prefer structured classification over the regex.
		{
			const structured = extractStructuredToolError(msg.content);
			if (structured) {
				errors.push({
					toolName: msg.name ?? "unknown",
					category: structured.category,
					kind: structured.kind,
					message: redactPiiContent(structured.message.slice(0, 500)),
					retryable: isRetryableCategory(structured.category),
					statusCode: structured.statusCode,
					hostname: structured.hostname,
					upstreamContentType: structured.upstreamContentType,
				});
				continue;
			}
		}

		// Use LangGraph ToolMessage.status as the error gate instead of regex on content.
		// LangGraph ToolNode sets status="error" when the tool throws (including MCP isError:true).
		// The old regex matched domain vocabulary like "totalErrorCount" causing false positives.

		// content-ok: msg is a ToolMessage here (the loop filters to tool results), not an
		// AIMessage; the serialized body feeds the regex error categorizer below.
		const content = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);

		// SIO-728: split off the structured payload before classifying or redacting.
		// Categorization runs on the human-readable prefix (matches today's behaviour).
		const sentinelIdx = content.indexOf(STRUCTURED_SENTINEL);
		const humanPart = sentinelIdx === -1 ? content : content.slice(0, sentinelIdx);
		let extra: { hostname?: string; upstreamContentType?: string; statusCode?: number } = {};
		if (sentinelIdx !== -1) {
			const jsonPart = content.slice(sentinelIdx + STRUCTURED_SENTINEL.length);
			try {
				extra = pickStructuredFields(JSON.parse(jsonPart));
			} catch {
				// Malformed sentinel payload -- ignore, keep going with humanPart only.
				// Don't fail the whole error-extraction path because one tool emitted bad JSON.
			}
		}

		const { category, retryable } = classifyToolError(humanPart);
		// SIO-707: redact PII before the message ever lands in logs or DataSourceResult.
		errors.push({
			toolName: msg.name ?? "unknown",
			category,
			message: redactPiiContent(humanPart.slice(0, 500)),
			retryable,
			...extra,
		});
	}
	return markRecoveredToolErrors(errors, messages);
}

// SIO-1164: a tool message counts as a "success" for recovery purposes when it is a tool
// message that extractToolErrors would NOT have classified as an error -- i.e. status !== "error"
// and it carries no structured/AWS _error envelope. Mirrors the exact gates in the loop above so
// recovery detection can never disagree with error classification about what failed.
function isToolSuccessMessage(msg: { _getType(): string; content: unknown; status?: string }): boolean {
	if (msg._getType() !== "tool") return false;
	if (msg.status === "error") return false;
	return extractStructuredToolError(msg.content) === null && extractAwsError(msg.content) === null;
}

// SIO-1164: marks each ToolError `recovered: true` when a LATER message in the trajectory is a
// successful call to the same tool name. Tool name is the only "category of intent" signal
// available without inspecting heterogeneous per-datasource arguments (raw SQL, log-group names,
// query DSL), so any later same-tool success recovers all earlier same-tool errors -- this
// reflects normal self-correction (retried query, retried after a timeout) rather than an
// unrecovered malfunction. Ordering matters: a success that occurred BEFORE an error (e.g. an
// early schema check succeeds, then the actual investigative query on the same tool fails) must
// NOT excuse that later, distinct failure -- CodeRabbit caught this in review.
function markRecoveredToolErrors(
	errors: ToolError[],
	messages: Array<{ _getType(): string; content: unknown; name?: string; status?: string }>,
): ToolError[] {
	// Highest message index, per tool name, at which a success occurred.
	const lastSuccessIndexByTool = new Map<string, number>();
	messages.forEach((msg, index) => {
		if (isToolSuccessMessage(msg)) lastSuccessIndexByTool.set(msg.name ?? "unknown", index);
	});
	if (lastSuccessIndexByTool.size === 0) return errors;

	// Errors are produced by the loop above in the same left-to-right order as `messages`, one
	// per erroring tool message, so replaying that same classification here recovers each error's
	// original message index without needing to thread it through the ToolError object.
	let errorCursor = 0;
	return errors.map((error) => {
		while (errorCursor < messages.length) {
			const msg = messages[errorCursor];
			const isThisError = msg?._getType() === "tool" && !isToolSuccessMessage(msg) && msg.name === error.toolName;
			if (isThisError) break;
			errorCursor++;
		}
		const errorIndex = errorCursor;
		errorCursor++;
		const lastSuccessIndex = lastSuccessIndexByTool.get(error.toolName);
		return lastSuccessIndex !== undefined && lastSuccessIndex > errorIndex ? { ...error, recovered: true } : error;
	});
}

const MAX_TOOLS_PER_AGENT = 25;
// SIO-785 follow-up (2026-05-18): floor lowered from 5 to 1 so a narrow action
// (e.g. dlq_messages -> 3 tools: consume / get_message / list_dlq_topics) is
// honored instead of falling through to the all-action fallback. The old floor
// was crowding out kafka_list_dlq_topics for DLQ-specific queries, breaking
// typed findings -> empty KafkaFindingsCard DLQ section.
const MIN_FILTERED_TOOLS = 1;

// SIO-1029: project-resolution tools that MUST be present regardless of which
// action group the filter selects. The gitlab sub-agent's code_analysis /
// merge_requests / pipelines actions are all project-scoped, but gitlab_search
// -- the only way to resolve a service name to a GitLab project id -- lives in
// the separate `search` action group and was being filtered out. Without it the
// LLM guessed a bare service name as project_id and every /api/v4/projects/{id}
// call 404'd. Union these in before the MAX_TOOLS_PER_AGENT slice so the agent
// can always search-first. Keep the count small (gitlab code_analysis=5 + this=1
// is well under 25).
// SIO-1076: also always include the Orbit entry points -- gitlab_graph_schema
// (FREE, grounds the graph) and gitlab_blast_radius (the marquee cross-project
// case). These are group-scoped and need NO project resolution, so they must
// stay reachable even when the action filter picks code_analysis. If Orbit is
// disabled the tools are simply absent from allTools and this is a no-op.
// SIO-1084: extend the search-first idiom to every datasource so each sub-agent
// ALWAYS has its "where to look" enumerator, regardless of which action group the
// filter selected -- the loose incident token must be resolvable to the real
// identifier (couchbase scope/collection, kafka topic/group, konnect control-plane,
// atlassian project/space) even on the lazy path (node disabled / probe failed).
// gitlab already resolves name -> numeric project_id via gitlab_search. Elastic is
// intentionally omitted: elasticsearch_search (which runs the service.name terms-agg)
// is already in the `search` group, and list_indices/indices_summary resolve index
// names, not service.name. Each set is tiny, keeping the datasource under
// MAX_TOOLS_PER_AGENT (25).
const RESOLUTION_TOOLS_BY_DATASOURCE: Record<string, string[]> = {
	// SIO-1178: gitlab_list_merge_requests is the sole input to extractGitLabFindings
	// and the gitlab-deploy-vs-datastore-runtime rule -- force-include it so the
	// flagship correlation path survives every action selection under the 25-tool cap.
	gitlab: ["gitlab_search", "gitlab_graph_schema", "gitlab_blast_radius", "gitlab_list_merge_requests"],
	// SIO-1087: include the index-check + key-lookup tools so the sub-agent can act on the
	// [indexed]/[NO INDEX] tags the focus block injects -- verify an index before SELECT, and fall
	// back to capella_get_document_by_id on an index-less collection instead of a doomed SELECT *.
	couchbase: ["capella_get_scopes_and_collections", "capella_get_system_indexes", "capella_get_document_by_id"],
	konnect: ["konnect_list_control_planes", "konnect_list_services"],
	// SIO-1096: the atlassian "resolution" tool is the broad Rovo `atlassian_search`, NOT
	// getVisibleJiraProjects. withResolutionTools force-includes these on every path AND prepends
	// them, so whatever is here is the tool the model is steered toward for discovery. Jira projects
	// are team/org-named (DSD, BP, PANDP), so getVisibleJiraProjects + name-match resolves nothing
	// and the model kept reporting "no prana project / 0 incidents". atlassian_search cross-searches
	// Jira+Confluence by the incident's domain terms and returns the tickets/runbooks in one call.
	// SIO-1182: findLinkedIncidents is the sole input to extractAtlassianFindings (same class as
	// gitlab_list_merge_requests above) -- force-include it so typed Atlassian findings survive
	// every action selection, not just incident_correlation.
	atlassian: ["atlassian_search", "findLinkedIncidents"],
	// SIO-1234: aws was absent entirely, so nothing was force-included -- and aws-agent
	// declares no `skills:` block either, so withSkillPromisedTools bound 0 for it too. With
	// 70 tools loaded and a 25 cap, the model followed its 32.7KB RULES.md and repeatedly
	// called tools that were never bound (aws_ecs_list_clusters, aws_logs_start_query, ...),
	// each returning `Tool "X" not found`.
	//
	// Kept small (9 of the 25 budget) so action selection still decides most of the belt.
	// aws_health_describe_events and aws_rds_describe_db_instances were also observed unbound
	// but are single-call groups; left out to hold the head down. If the AWS eval still misses
	// them they belong here and MIN_ACTION_TOOLS drops to 7.
	//
	// The four logs_* entries are the COMPLETE async CloudWatch Insights chain
	// (describe_log_groups -> get_log_group_fields -> start_query -> get_query_results), and
	// they are here as a unit on purpose. A partially-bound chain is worse than an unbound one:
	// start_query without get_query_results lets the model launch a query whose result it can
	// never read, and SIO-1232 already had to make get_query_results loop-guard-exempt for the
	// same reason. The SIO-1161 belt test pins that this chain survives a 4-group union.
	aws: [
		"aws_list_estates",
		"aws_ecs_list_clusters",
		"aws_ecs_list_services",
		"aws_ecs_describe_services",
		"aws_logs_describe_log_groups",
		"aws_logs_get_log_group_fields",
		"aws_logs_start_query",
		"aws_logs_get_query_results",
		"aws_cloudwatch_describe_alarms",
	],
	// NOTE: kafka is deliberately NOT here. Force-including kafka_list_topics would
	// reintroduce the SIO-785 regression -- the broad topic-listing tool crowds out
	// the specialized dlq_messages tools (kafka_list_dlq_topics), breaking the typed
	// KafkaFindingsCard DLQ extractor. Kafka identifier resolution is handled up-front
	// by the resolveIdentifiers node (Part B) instead, which does not touch the
	// per-action tool budget.
};

// SIO-1029 introduced withResolutionTools here to union the datasource's always-include tools
// into a filtered selection. SIO-1234 replaced it with requiredHeadTools below: unioning only
// the MISSING ones left a required tool that was also action-selected in the truncatable tail,
// so "always-include" was never actually guaranteed. requiredHeadTools promotes all of them.

// SIO-1228: union in the tools the sub-agent's SKILL.md prose tells the model to call.
// Skill bodies are in the system prompt on EVERY turn (prompt-context.ts calls
// buildSystemPrompt with no activeSkills filter), but action-driven selection binds only
// the groups the entity extractor picked. On a turn that missed the matching group the
// model followed its instructions, called an unbound tool, got `Tool "X" not found`
// -- classified `unknown` -> retryable -- and burned ReAct iterations to the recursion
// limit, contributing nothing. Binding what the prompt promises makes the two sources of
// truth unable to diverge.
//
// `skillToolNames` deliberately over-matches (the extractor also picks up prose
// identifiers like `project_id`); intersecting with allTools here is what discards them,
// so a name that is not a real tool is inert rather than an error.
function withSkillPromisedTools(
	selected: StructuredToolInterface[],
	allTools: StructuredToolInterface[],
	skillToolNames: string[] | undefined,
): StructuredToolInterface[] {
	if (!skillToolNames || skillToolNames.length === 0) return selected;
	const present = new Set(selected.map((t) => t.name));
	const missingSet = new Set(skillToolNames.filter((name) => !present.has(name)));
	if (missingSet.size === 0) return selected;
	const extras = allTools.filter((t) => missingSet.has(t.name));
	if (extras.length === 0) return selected;
	return [...extras, ...selected];
}

// SIO-1234: the action-selected tools are the ones chosen FOR THIS QUERY, so they are the
// last thing that should be dropped -- yet they were the only thing being dropped. The old
// withRequiredTools (removed here, replaced by requiredHeadTools + composeBoundTools) prepended
// via `[...extras, ...selected]` and the caller sliced to 25, so a head of 25+ names silently
// truncated the entire action-selected tail to nothing.
//
// Guarantee at least MIN_ACTION_TOOLS query-relevant tools survive, taking the space from the
// head instead. Below the cap this is byte-identical to the old concatenation for every agent
// in the repo today (gitlab is the largest at head 18 + 5 selected = 23), so it only becomes
// load-bearing once a head grows past the budget -- which is exactly the aws-agent case.
const MIN_ACTION_TOOLS = 8;

export function composeBoundTools(
	head: StructuredToolInterface[],
	selected: StructuredToolInterface[],
	max: number = MAX_TOOLS_PER_AGENT,
	minAction: number = MIN_ACTION_TOOLS,
): StructuredToolInterface[] {
	// Dedup BEFORE budgeting, not after. requiredHeadTools now promotes required tools that were
	// also action-selected, so the two lists genuinely overlap; counting a duplicate against the
	// action quota would silently buy fewer distinct tools than the quota claims.
	const headNames = new Set(head.map((t) => t.name));
	const seenTail = new Set<string>();
	const tail: StructuredToolInterface[] = [];
	for (const tool of selected) {
		if (headNames.has(tool.name) || seenTail.has(tool.name)) continue;
		seenTail.add(tool.name);
		tail.push(tool);
	}

	// Reserve up to minAction slots for action-selected tools, but never more than exist and
	// never fewer than the head leaves spare (so an under-budget composition is unchanged).
	const actionQuota = Math.min(tail.length, Math.max(minAction, max - head.length));
	const headQuota = Math.min(head.length, max - actionQuota);
	return [...head.slice(0, headQuota), ...tail.slice(0, actionQuota)];
}

// SIO-1234: the head is EVERY resolution tool, then every skill-promised tool -- not just the
// ones missing from `selected`.
//
// withResolutionTools/withSkillPromisedTools only ever PREPENDED the missing ones, leaving a
// required tool that happened to also be action-selected sitting in the tail where the 25-slice
// could still cut it. "Force-included" was therefore never actually a guarantee. That latent gap
// is what split the async CloudWatch Insights pair: aws_logs_start_query landed at slot 25 and
// aws_logs_get_query_results at 26, handing the model a way to start a query it could never read.
// The same hole applied to gitlab_list_merge_requests and findLinkedIncidents, each the sole
// input to a typed findings extractor and each truncatable in exactly the same way.
//
// Promoting them makes force-inclusion mean what its own comments already claimed. A promoted
// tool is removed from the tail by composeBoundTools' dedup, so overlap costs no extra slots.
function requiredHeadTools(
	allTools: StructuredToolInterface[],
	dataSourceId: string,
	skillToolNames: string[] | undefined,
): StructuredToolInterface[] {
	const byName = new Map(allTools.map((t) => [t.name, t]));
	const head: StructuredToolInterface[] = [];
	const added = new Set<string>();
	const push = (name: string) => {
		const tool = byName.get(name);
		// Intersecting with allTools is what discards prose identifiers that are not real tools
		// (SIO-1228's "stale names are harmless" property).
		if (!tool || added.has(name)) return;
		added.add(name);
		head.push(tool);
	};
	// Resolution first: the SIO-1029/1084 A5 invariant steers the model to its "where to look"
	// enumerator before anything else.
	for (const name of RESOLUTION_TOOLS_BY_DATASOURCE[dataSourceId] ?? []) push(name);
	for (const name of skillToolNames ?? []) push(name);
	return head;
}

// SIO-1234: tell the model what it actually has. This is the ONLY in-loop lever available:
// `Tool "X" not found` is thrown by LangGraph's ToolNode (@langchain/langgraph@1.2.2,
// dist/prebuilt/tool_node.cjs:144) and NEVER reaches instrumentTools -- the proxy in
// sub-agent-instrumentation.ts only wraps tools that were bound in the first place, so no
// tool-level guard can ever observe the failure. The prompt is the only place to intervene.
//
// The "record it as an un-queried gap" instruction matters as much as the list: without it a
// model that notices a missing tool tends to retry it or invent a substitute, which is how a
// single unbound name burned iterations to the recursion limit.
export function buildBoundToolsBlock(tools: StructuredToolInterface[]): string {
	const names = tools.map((t) => t.name).join(", ");
	return `## Tools bound this turn

These are the ONLY tools available to you on this turn: ${names || "(none)"}

If any step in your instructions names a tool that is not in that list, SKIP that step and record it as an un-queried gap in your findings. Do not call it and do not retry it -- it is not bound this turn and the call will fail.

Skipping is licensed ONLY for a step whose tool is missing from that list. It is never a licence to end the turn without querying: pick the closest bound tool and run it. Make at least one call from this list before you write your findings, and do not describe a call you have not made.`;
}

// The bind-site composition: head-vs-selected budgeting in one place, so all three call sites
// below cannot drift apart.
function bindTools(
	selected: StructuredToolInterface[],
	allTools: StructuredToolInterface[],
	dataSourceId: string,
	skillToolNames: string[] | undefined,
): StructuredToolInterface[] {
	return composeBoundTools(requiredHeadTools(allTools, dataSourceId, skillToolNames), selected);
}

// SIO-738: Shared merge step so the augmentation test exercises the same
// dedup logic the production runSubAgent path uses. Returns baseActions
// reference unchanged when keywordActions is empty (no extra allocation).
export function mergeKeywordActions(baseActions: string[], keywordActions: string[]): string[] {
	if (keywordActions.length === 0) return baseActions;
	return [...new Set([...baseActions, ...keywordActions])];
}

// SIO-785 follow-up (2026-05-18): when a high-precision keyword match flags a
// specific intent (e.g. dlq_messages from "dead letter"), drop ambient actions
// that would surface tools competing for the same intent (e.g. kafka_list_topics
// from topic_throughput / describe_topic). Without this, the LLM picks the
// generic listing tool over the specialized one and the typed extractor sees
// no DLQ data.
const HIGH_PRECISION_NARROWING_RULES: Record<string, string[]> = {
	// When the user asks about DLQs explicitly, hide the broad topic-listing
	// actions. Kept actions: dlq_messages plus anything else the keyword pass
	// matched (those are also high-confidence).
	dlq_messages: ["topic_throughput", "describe_topic"],
};

export function narrowOnHighPrecisionIntent(mergedActions: string[], keywordActions: string[]): string[] {
	let actions = mergedActions;
	for (const trigger of keywordActions) {
		const toDrop = HIGH_PRECISION_NARROWING_RULES[trigger];
		if (!toDrop || toDrop.length === 0) continue;
		const dropSet = new Set(toDrop);
		// Don't drop something the keyword pass itself anchored.
		for (const k of keywordActions) dropSet.delete(k);
		const next = actions.filter((a) => !dropSet.has(a));
		if (next.length === 0) continue; // refuse to empty the list
		actions = next;
	}
	return actions;
}

// SIO-742: deterministic cluster-health action inference for the kafka sub-agent.
// The substring keyword augmenter in matchActionsByKeywords misses natural
// phrasings like "Kafka Rest" (not in action_keywords.restproxy) or "how is my
// Kafka doing" (cluster-health implied but no single keyword present). This
// function returns the full Confluent action set when the query references
// cluster health, multiple components together, or asks reachability questions,
// guaranteeing iteration-1 probes of restproxy/ksql/connect/SR.
//
// Kafka-only -- the supervisor's other sub-agents have their own keyword sets.
const CLUSTER_HEALTH_PATTERNS: RegExp[] = [
	/\bcluster\s+health\b/i,
	/\brelated\s+services\b/i,
	/\bhow\s+(is|are)\b.*\b(kafka|cluster|confluent)\b/i,
	/\bconfluent\b.*\b(rest|platform|services)\b/i,
	/\b(connect|ksql|schema\s+registry|rest\s+proxy)\b.*\b(working|up|enabled|healthy|reachable|down)\b/i,
	/\bkafka\s+(rest|connect|and)\b/i,
];

export function inferClusterHealthActions(query: string, dataSourceId: string): string[] {
	if (dataSourceId !== "kafka") return [];
	if (!query) return [];
	const matched = CLUSTER_HEALTH_PATTERNS.some((re) => re.test(query));
	if (!matched) return [];
	return ["health_check", "cluster_info", "restproxy", "ksql", "connect_status", "schema_registry"];
}

export function selectToolsByAction(
	allTools: StructuredToolInterface[],
	dataSourceId: string,
	toolActions: Record<string, string[]> | undefined,
	toolDef: ToolDefinition | undefined,
	// SIO-1228: tool names the sub-agent's skill prose promises. Passed in rather than
	// resolved here so this stays a pure function -- reaching for getAgent() would make
	// every caller mock prompt-context, which pollutes other tests in this package.
	skillToolNames?: string[],
): { tools: StructuredToolInterface[]; filtered: boolean } {
	if (allTools.length <= MAX_TOOLS_PER_AGENT) {
		return { tools: allTools, filtered: false };
	}

	if (!toolDef?.tool_mapping?.action_tool_map) {
		// Skill tools only -- this path deliberately does NOT union the resolution set, so
		// its pre-SIO-1228 behaviour is preserved exactly. Every shipped datasource has an
		// action_tool_map, so the branch is unreachable for them today; widening the
		// resolution invariant here would be an untested change unrelated to this fix.
		const withSkills = withSkillPromisedTools(allTools.slice(0, MAX_TOOLS_PER_AGENT), allTools, skillToolNames);
		return { tools: withSkills.slice(0, MAX_TOOLS_PER_AGENT), filtered: true };
	}

	const actions = toolActions?.[dataSourceId];
	if (actions && actions.length > 0) {
		const { toolNames } = resolveActionTools(toolDef, actions);
		if (toolNames.length > 0) {
			const nameSet = new Set(toolNames);
			const selected = allTools.filter((t) => nameSet.has(t.name));
			if (selected.length >= MIN_FILTERED_TOOLS) {
				return { tools: bindTools(selected, allTools, dataSourceId, skillToolNames), filtered: true };
			}
		}
	}

	const allActionNames = getAllActionToolNames(toolDef);
	if (allActionNames.length > 0) {
		const nameSet = new Set(allActionNames);
		const selected = allTools.filter((t) => nameSet.has(t.name));
		if (selected.length >= MIN_FILTERED_TOOLS) {
			return { tools: bindTools(selected, allTools, dataSourceId, skillToolNames), filtered: true };
		}
	}

	// SIO-1084: even on the raw-slice fallback (reached when the action_tool_map
	// names don't resolve to runtime tool names -- e.g. konnect's YAML uses bare
	// `list_services` while runtime tools are `konnect_*`-prefixed), still union in
	// the datasource's resolution tools so the "where to look" enumerator is always
	// present, then slice. Guarantees the A5 invariant on every path.
	// SIO-1228: same reasoning for the skill-promised tools -- the prompt makes the same
	// promises regardless of which path selection took.
	return {
		tools: bindTools(allTools.slice(0, MAX_TOOLS_PER_AGENT), allTools, dataSourceId, skillToolNames),
		filtered: true,
	};
}

interface RunOptions {
	deploymentId?: string;
}

// SIO-649: One sub-agent invocation. Extracted so the elastic branch can call it once per
// selected deployment from queryDataSource. Non-elastic agents call it exactly once.
// Use a structural type to side-step pino's strict Logger<TLevels, TCustomLevels> generics --
// we only need the log methods here, not the full type surface.
interface LogSink {
	info: (...args: unknown[]) => unknown;
	warn: (...args: unknown[]) => unknown;
	error: (...args: unknown[]) => unknown;
	child: (bindings: Record<string, unknown>) => LogSink;
}

async function runSubAgent(
	state: AgentStateType,
	dataSourceId: string,
	agentName: string,
	isRetry: boolean,
	log: LogSink,
	config: RunnableConfig | undefined,
	options: RunOptions = {},
): Promise<DataSourceResult> {
	const startTime = Date.now();
	const { deploymentId } = options;
	// SIO-1232: hoisted out of the try so the catch can report the budget that actually fired.
	// Undefined means we threw before the timer was armed.
	let effectiveTimeoutMs: number | undefined;
	try {
		const allTools = getToolsForDataSource(dataSourceId);
		// SIO-750: wrap the base sub-agent prompt with the investigation focus
		// anchor when present, so ReAct loops stay scoped to the chat session's
		// investigation rather than wandering to unrelated clusters or services.
		// We don't thread the focus through buildSubAgentPrompt itself because
		// that helper is shared with non-investigation flows.
		const baseSystemPrompt = buildSubAgentPrompt(agentName);
		const focus = state.investigationFocus;
		// SIO-1079: the focus block now always carries a current-time anchor (mirroring the
		// normalizer) so a sub-agent choosing a time-windowed tool call (e.g.
		// aws_logs_start_query epoch seconds) resolves it against a real clock instead of
		// guessing an absolute epoch and landing outside the data source's retention window.
		// SIO-1084: also inject this datasource's pre-resolved canonical identifiers
		// (from the resolveIdentifiers node), so the sub-agent queries the real
		// service.name / log group / scope that exists instead of guessing the token.
		const focusBlock = buildFocusBlock(focus, new Date().toISOString(), state.resolvedIdentifiers, dataSourceId);
		// SIO-1155: a correlation refetch carries a targeted directive (set per-Send by
		// the enforceCorrelations router); append it to the volatile block so the
		// sub-agent fetches the rule's entities instead of re-running the focus anchor.
		const volatileBlock = state.correlationFetchDirective
			? `${focusBlock}

${state.correlationFetchDirective}`
			: focusBlock;
		// SIO-1235: pass the sub-agent identity so this specialist resolves ITS OWN manifest model
		// instead of silently inheriting the root manifest's. Deliberately the same `agentName`
		// that buildSubAgentPrompt (above) and getSkillToolNames (below) already use, so the
		// prompt, the bound tools and the model can never be resolved from three different agents.
		const llm = createLlm("subAgent", "incident-analyzer", agentName);

		if (allTools.length === 0) {
			log.warn({ deploymentId }, "No MCP tools available, skipping");
			return {
				dataSourceId,
				data: `No tools available for ${dataSourceId}. MCP server may not be connected.`,
				status: "error",
				duration: Date.now() - startTime,
				error: "No MCP tools available",
				...(deploymentId && { deploymentId }),
			};
		}

		const lastUserMessage = state.messages.filter((m) => m._getType() === "human").pop();
		const toolDef = getToolDefinitionForDataSource(dataSourceId);

		// SIO-738: Deterministic keyword pass augments LLM-extracted actions when the
		// entity extractor omits an action despite a clear keyword in the prompt (e.g.
		// the user names "REST Proxy" or "Connect" but the LLM picks only consumer_lag
		// + cluster_info). The base toolActions still drives selection; keyword
		// matches are union-merged so non-matching prompts behave exactly as before.
		const query = lastUserMessage ? extractTextFromContent(lastUserMessage.content) : "";
		const baseActions = state.extractedEntities.toolActions?.[dataSourceId] ?? [];
		const keywordActions = toolDef ? matchActionsByKeywords(query, toolDef) : [];
		// SIO-742: cluster-health auto-include for kafka (covers phrasings the
		// substring augmenter misses, e.g. "Kafka Rest", "related services").
		const clusterHealthActions = inferClusterHealthActions(query, dataSourceId);
		const augmentationActions = mergeKeywordActions(keywordActions, clusterHealthActions);
		const preNarrowMerged = mergeKeywordActions(baseActions, augmentationActions);
		// SIO-785 follow-up (2026-05-18): when the deterministic keyword pass detects
		// a high-precision intent (currently dlq_messages — "dead letter" / "dlq"),
		// strip ambient LLM-added topic-discovery actions (topic_throughput,
		// describe_topic) that would otherwise expose kafka_list_topics. The LLM
		// trusts kafka_list_topics's "prefix" example over SOUL directives and
		// picks it instead of kafka_list_dlq_topics — leaving typed dlqTopics empty
		// and the UI card invisible. The remote AgentCore-deployed tool description
		// is not editable from local code, so we narrow the toolset upstream.
		const mergedActions = narrowOnHighPrecisionIntent(preNarrowMerged, keywordActions);
		const augmentedToolActions =
			augmentationActions.length > 0 || mergedActions.length !== preNarrowMerged.length
				? { ...state.extractedEntities.toolActions, [dataSourceId]: mergedActions }
				: state.extractedEntities.toolActions;

		if (augmentationActions.length > 0 || mergedActions.length !== preNarrowMerged.length) {
			log.info(
				{
					dataSourceId,
					baseActions,
					keywordActions,
					clusterHealthActions,
					preNarrowMerged,
					mergedActions,
					deploymentId,
				},
				"Augmented toolActions via keyword match",
			);
		}

		// SIO-1228: bind whatever this sub-agent's skill prose promises, so the prompt can
		// never instruct the model to call a tool the action filter withheld. Keyed off the
		// SAME agentName buildSubAgentPrompt used above, so the bound set and the prompt
		// that makes the promises can never be resolved from different agents.
		const skillToolNames = getSkillToolNames(agentName);
		const { tools, filtered } = selectToolsByAction(
			allTools,
			dataSourceId,
			augmentedToolActions,
			toolDef,
			skillToolNames,
		);
		log.info(
			{ toolCount: tools.length, totalTools: allTools.length, filtered, deploymentId },
			"Creating ReAct agent with tools",
		);

		// SIO-1040: cache the base sub-agent prompt (stable) so the up-to-40 ReAct
		// iterations and per-deployment fan-out share the Bedrock cache prefix within
		// the 5-min TTL; the per-turn investigation focus stays volatile (uncached).
		// SIO-1234: the bound-tools manifest is built AFTER selection (it names what was
		// actually bound this turn) and goes in the VOLATILE block -- it varies per turn, so
		// putting it in the stable half would break the cache prefix on every request.
		const systemPrompt = buildCachedSystemMessage(
			baseSystemPrompt,
			`${volatileBlock}\n\n${buildBoundToolsBlock(tools)}`,
		);

		// SIO-686: per-tool-result observability so we can size the cap from real traces.
		// When SUBAGENT_TOOL_RESULT_CAP_BYTES is set, oversized ToolMessage.content is
		// JSON-aware truncated before re-entering the ReAct loop.
		const capBytes = getSubAgentToolCapBytes();
		// SIO-1248: collects each tool result at full size, before the LLM-facing cap, so
		// toolOutputs[] below can be built from raw bytes instead of the truncated
		// ToolMessages. Populated on every path (normal, loop-guard stop, recursion-limit
		// salvage) because the instrumented tool instances are shared with agent.stream().
		const rawOutputs: RawToolOutput[] = [];
		const instrumentedTools = instrumentTools(tools, {
			dataSourceId,
			deploymentId,
			log,
			capBytes,
			config,
			rawOutputs,
		});

		// SIO-1250: bound the CUMULATIVE loop context. The per-result cap above cannot do
		// this -- ~6 results at 131_072 already reach 200k. The hook elides the oldest tool
		// CONTENT (never removes a message, so tool_call pairing cannot break) and returns
		// it as `llmInputMessages`, which overrides only what the model sees; canonical
		// `messages` stays whole for extractToolErrors and the SIO-1248 raw capture.
		//
		// Always returns llmInputMessages, even when nothing was elided: the channel reducer
		// is (_, update) => messagesStateReducer([], update), so omitting the key leaves the
		// PREVIOUS step's value in place and the model would silently reason on a stale,
		// shorter history.
		const contextBudgetBytes = getSubAgentContextBudgetBytes();
		const agent = createReactAgent({
			llm,
			tools: instrumentedTools,
			messageModifier: systemPrompt,
			...(contextBudgetBytes != null && {
				preModelHook: (hookState: { messages: BaseMessage[] }) => {
					const budgeted = applyContextBudget(hookState.messages, contextBudgetBytes);
					if (budgeted.elidedCount > 0) {
						log.warn(
							{
								event: "subagent.context_budget_pressure",
								deploymentId,
								budgetBytes: contextBudgetBytes,
								totalBytes: budgeted.totalBytes,
								elidedCount: budgeted.elidedCount,
								freedBytes: budgeted.freedBytes,
							},
							"Sub-agent context budget exceeded; elided oldest tool results",
						);
					}
					return { llmInputMessages: budgeted.messages };
				},
			}),
		});

		const messages = lastUserMessage ? [lastUserMessage] : state.messages.slice(-1);

		const recursionLimit = getSubAgentRecursionLimit(dataSourceId);
		// SIO-1110: cap the timer at the remaining graph budget minus the aggregation
		// reserve so a late dispatch (alignment retry) can never starve aggregation.
		// First attempts start with ample remaining budget, so the cap never binds there.
		// SIO-1232: a retry gets a reduced base so it cannot consume the whole remaining runway.
		const baseTimeoutMs = isRetry ? getSubAgentRetryTimeoutMs() : getSubAgentTimeoutMs();
		const timeoutMs = capSubAgentTimeoutMs(baseTimeoutMs, getGraphDeadlineAt(config));
		effectiveTimeoutMs = timeoutMs;
		log.info(
			{ deploymentId, recursionLimit, ...(timeoutMs < baseTimeoutMs && { cappedTimeoutMs: timeoutMs }) },
			"Invoking sub-agent",
		);
		// Live progress signal: fires once at the true start of this sub-agent branch
		// (each queryDataSource Send is a distinct branch, so this fills the gap the
		// shared node-level node_start/node_end can't -- see sse-pump.ts's
		// "subagent_progress" forwarding).
		await dispatchCustomEvent("subagent_progress", { dataSourceId, deploymentId, status: "running" }, config);
		// SIO-1029: stream so a recursion-limit blow-up salvages partial findings
		// (see invokeSubAgentWithSalvage) instead of returning a hard error with
		// no data. Behaviour on normal completion is unchanged (final { messages }).
		const response = await invokeSubAgentWithSalvage((opts) => agent.stream({ messages }, opts), {
			...config,
			signal: AbortSignal.timeout(timeoutMs),
			runName: deploymentId ? `${agentName}[${deploymentId}]` : agentName,
			metadata: {
				...config?.metadata,
				data_source_id: dataSourceId,
				request_id: state.requestId,
				...(deploymentId && { deployment_id: deploymentId }),
			},
			tags: [
				...(config?.tags ?? []),
				"sub-agent",
				`datasource:${dataSourceId}`,
				...(deploymentId ? [`deployment:${deploymentId}`] : []),
			],
			recursionLimit,
		});
		const duration = Date.now() - startTime;
		// SIO-1227: resolved BEFORE the completion log so responseLength reports the answer we will
		// actually return, not the length of a text-free final message (which logged 0 while the
		// findings sat in an earlier turn -- how this bug hid).
		const recovered = lastTextualResponse(response.messages);
		const noFindings = recovered === null;

		const toolErrors = extractToolErrors(response.messages);
		const toolMessages = response.messages.filter((m: { _getType(): string }) => m._getType() === "tool");
		const allToolsFailed = toolMessages.length > 0 && toolErrors.length === toolMessages.length;
		const truncated = response.truncated;

		// SIO-707: emit per-failure visibility ({toolName, category, message}) alongside the count.
		// toolErrorCount is preserved for backward compatibility with existing log parsers.
		// Messages are already PII-redacted in extractToolErrors above.
		// SIO-1029: `truncated` flags a recursion-limit salvage -- partial results, not a hard error.
		log.info(
			{
				duration,
				deploymentId,
				messageCount: response.messages.length,
				responseLength: recovered?.text.length ?? 0,
				...(recovered !== null &&
					recovered.index !== response.messages.length - 1 && { recoveredFromIndex: recovered.index }),
				toolErrorCount: toolErrors.length,
				allToolsFailed,
				...(truncated && { truncated: true }),
				...(toolErrors.length > 0 && {
					toolErrors: toolErrors.map((e) => ({
						toolName: e.toolName,
						category: e.category,
						message: e.message,
					})),
				}),
			},
			truncated ? "Sub-agent completed (truncated at recursion limit; partial results)" : "Sub-agent completed",
		);

		// SIO-1043: cap toolOutputs[].rawJson at creation so the persisted checkpoint state
		// doesn't grow unboundedly. SIO-1159: typed-finding tools are EXEMPT, mirroring the
		// in-flight skip in sub-agent-instrumentation.ts -- extractFindings runs on these
		// persisted objects, and truncateToolOutput's "text" fallback is NOT structure-
		// preserving (a 500KB elastic "Document ID:" block string capped at 32KB parses to
		// zero findings; observed live as ElasticFindingsCard rawCount 0 in run 270378e0).
		// Bounded regardless: pruneThreadState resets dataSourceResults after every turn.
		const stateCapBytes = getSubAgentStateOutputCapBytes();
		// SIO-1248: prefer the raw capture -- response.messages carries the CAPPED copies, so
		// deriving persisted state from them would hand the extractors the truncator's small
		// fixed slice (measured: 900 synthetic monitors -> 3). Fall back to the messages when
		// the collector is empty so any path that bypasses the instrumented tools still
		// persists what it always did.
		// The switch is run-wide, so an INCOMPLETE rawOutputs would drop every toolMessages
		// entry rather than just the missing one. The capture is exhaustive today (success,
		// loop-guard stop and throw all record), but a future path that yields a ToolMessage
		// without going through the instrumented invoke would regress this silently. Surface
		// the divergence rather than quietly degrading persisted findings.
		if (rawOutputs.length > 0 && rawOutputs.length !== toolMessages.length) {
			log.warn(
				{
					event: "subagent.raw_output_count_mismatch",
					deploymentId,
					rawOutputCount: rawOutputs.length,
					toolMessageCount: toolMessages.length,
				},
				"Raw tool-output capture diverged from tool messages; persisted findings may be incomplete",
			);
		}
		const persistSource: Array<{ name?: string; content: unknown }> =
			rawOutputs.length > 0
				? rawOutputs.map((o) => ({ name: o.toolName, content: o.content }))
				: toolMessages.map((m: { name?: string; content: unknown }) => ({ name: m.name, content: m.content }));
		const toolOutputs = persistSource.map((m: { name?: string; content: unknown }) => {
			const toolName = m.name ?? "unknown";
			const out = buildPersistedToolOutput(toolName, normalizeToolContent(m.content), stateCapBytes);
			if (out.capSkippedBytes != null) {
				log.info(
					{ event: "subagent.state_output_cap_skipped", deploymentId, toolName, bytes: out.capSkippedBytes },
					"Persisted tool output cap skipped to preserve typed-finding JSON",
				);
			}
			if (out.truncation) {
				log.info(
					{ event: "subagent.state_output_truncated", deploymentId, toolName, ...out.truncation },
					"Persisted tool output truncated",
				);
			}
			return { toolName, rawJson: out.rawJson };
		});

		// SIO-1208: deterministic placement baseline for the network map. The SIO-1204
		// builder only renders what the loop fetched; guarantee the workload -> IP ->
		// subnet -> VPC layer on every AWS turn (per estate -- this runs inside the
		// withAwsEstate ALS scope). Reuses the loop's ECS outputs before spending
		// calls; soft-failing so it can never degrade the sub-agent result.
		if (dataSourceId === "aws" && isNetworkBaselineEnabled()) {
			const baselineStart = Date.now();
			try {
				const focusServices = [
					...new Set(
						[
							...(state.investigationFocus?.services ?? []),
							...(state.normalizedIncident?.affectedServices?.map((s) => s.name) ?? []),
						].filter((s): s is string => typeof s === "string" && s.length > 0),
					),
				];
				const toolsByName = new Map(allTools.map((t) => [t.name, t]));
				const { outputs: baseline, diagnostics: baselineDiagnostics } = await fetchNetworkBaseline({
					invoke: async (toolName, args) => {
						const tool = toolsByName.get(toolName);
						if (!tool) throw new Error(`tool unavailable: ${toolName}`);
						return normalizeToolContent(await tool.invoke(args));
					},
					hasTool: (name) => toolsByName.has(name),
					existingOutputs: toolOutputs,
					focusServices,
				});
				// SIO-1043 parity: baseline outputs go through the same persisted-state
				// cap as every ReAct-loop output, so checkpoint state stays bounded.
				if (baseline.length > 0) {
					toolOutputs.push(
						...baseline.map((o) => ({
							toolName: o.toolName,
							// buildPersistedToolOutput takes the raw content STRING; baseline
							// rawJson is already parsed, so re-serialize for the byte cap.
							rawJson: buildPersistedToolOutput(
								o.toolName,
								typeof o.rawJson === "string" ? o.rawJson : JSON.stringify(o.rawJson),
								stateCapBytes,
							).rawJson,
						})),
					);
				}
				// SIO-1210: diagnostics explain an empty `added` -- distinguishes "nothing
				// to find" (skippedReason) from "found candidates but rejected them" and
				// flags the EKS EC2-instance fallback when it fired.
				log.info(
					{
						event: "subagent.network_baseline",
						deploymentId,
						added: baseline.map((o) => o.toolName),
						durationMs: Date.now() - baselineStart,
						...baselineDiagnostics,
					},
					"Network placement baseline fetched",
				);
			} catch (error) {
				log.warn(
					{
						deploymentId,
						durationMs: Date.now() - baselineStart,
						error: error instanceof Error ? error.message : String(error),
					},
					"Network placement baseline failed; continuing without it",
				);
			}
		}

		// SIO-1029: a truncated run that still gathered tool data is partial-success, not error --
		// salvage what the sub-agent observed rather than blanking the datasource.
		// SIO-1227: the data/status decision now lives in buildSubAgentOutcome so the
		// never-success-with-no-findings invariant is unit-testable. Previously this read
		// extractTextFromContent(messages.at(-1).content), which yielded "" whenever the final
		// message carried no text -- a reasoning-only turn, or a mid-loop message on a truncated run.
		const outcome = buildSubAgentOutcome({
			recovered,
			allToolsFailed,
			truncated: truncated === true,
			messageCount: response.messages.length,
			toolErrorCount: toolErrors.length,
		});
		const data = outcome.data;

		// Recovering from an earlier turn is normal on a truncated run but unexpected otherwise, so
		// log it either way -- it is the signal that the model ended on a text-free message.
		if (recovered !== null && recovered.index !== response.messages.length - 1) {
			log.info(
				{
					deploymentId,
					recoveredFromIndex: recovered.index,
					lastIndex: response.messages.length - 1,
					truncated: truncated === true,
				},
				"Sub-agent final message carried no text; recovered findings from an earlier turn",
			);
		}
		if (noFindings) {
			log.warn(
				{ deploymentId, messageCount: response.messages.length, truncated: truncated === true },
				"Sub-agent produced no textual findings in any message; reporting as error rather than empty success",
			);
		}

		return {
			dataSourceId,
			data,
			status: outcome.status,
			duration,
			toolOutputs,
			isAlignmentRetry: isRetry,
			messageCount: response.messages.length,
			...(deploymentId && { deploymentId }),
			...(toolErrors.length > 0 && { toolErrors }),
			...(outcome.error !== undefined && { error: outcome.error }),
		};
	} catch (error) {
		const duration = Date.now() - startTime;
		const message = error instanceof Error ? error.message : String(error);
		const errorName = error instanceof Error ? error.name : "";
		const aborted = isSubAgentAbort(message, errorName);
		// errorName is logged because the exact name LangGraph surfaces when AbortSignal.timeout
		// fires mid-stream() is not pinned by any test -- it may be re-wrapped. Recording it means
		// the next occurrence tells us definitively instead of requiring another investigation.
		log.error({ duration, deploymentId, aborted, errorName, error: message }, "Sub-agent failed");
		return {
			dataSourceId,
			data: null,
			status: "error",
			duration,
			isAlignmentRetry: isRetry,
			...(deploymentId && { deploymentId }),
			error: message,
			// SIO-1232: without this the result carries NO toolErrors, and isDataSourceRetryable
			// documents "No toolErrors means we don't know the failure mode -- default to retryable".
			// So a sub-agent that burned its entire wall-clock budget was re-dispatched for another
			// full one (observed: gitlab 360s + 360s inside an 876s run). A timeout will time out
			// again; it is the one failure we can be sure a blind retry cannot fix.
			//
			// DELIBERATE divergence from isRetryableCategory: the category stays "transient" so
			// summarizeFirstAttempts still labels it transient -- which is TRUE, it was a timeout --
			// while retryable:false drives the decision. alignment.ts documents ToolError.retryable
			// as the single source of truth. Any future code that recomputes retryability FROM the
			// category would silently reintroduce the double-timeout; the test pins this pairing.
			...(aborted && {
				toolErrors: [
					{
						toolName: "__subagent_timeout__",
						category: "transient" as const,
						kind: "timeout" as const,
						message:
							effectiveTimeoutMs === undefined
								? `sub-agent aborted after ${duration}ms`
								: `sub-agent aborted after ${duration}ms (timeout ${effectiveTimeoutMs}ms)`,
						retryable: false,
					},
				],
			}),
		};
	} finally {
		// Live progress signal: marks this branch done regardless of exit path
		// (success, all-tools-failed, or thrown error) so the UI's live sub-agent
		// line flips from "running" to "done" instead of sticking forever.
		await dispatchCustomEvent("subagent_progress", { dataSourceId, deploymentId, status: "done" }, config);
	}
}

export async function queryDataSource(
	state: AgentStateType,
	config?: RunnableConfig,
): Promise<Partial<AgentStateType>> {
	const dataSourceId = state.currentDataSource;
	const agentName = AGENT_NAMES[dataSourceId] ?? "elastic-agent";
	const isRetry = state.alignmentHints.length > 0;
	const log = logger.child({ requestId: state.requestId, dataSourceId, isRetry });

	log.info({ agentName }, "Sub-agent starting");

	// SIO-649: Fan out across selected deployments for elastic only. Other sub-agents ignore
	// targetDeployments entirely -- empty/unset falls through to the non-fan-out path, which
	// is the pre-SIO-649 behavior.
	// SIO-697: an alignment retry uses retryDeployments (only the deployments that failed on
	// the first attempt), so we don't re-run siblings that already succeeded.
	const deployments =
		dataSourceId === "elastic"
			? isRetry && state.retryDeployments.length > 0
				? state.retryDeployments
				: state.targetDeployments
			: [];

	// SIO-828: AWS fan-out is by estate, populated by awsEstateRouter. Mirrors the
	// elastic pattern but uses tool-arg injection (withAwsEstate ALS) instead of
	// HTTP headers. Empty awsTargetEstates falls through to a non-fan-out path
	// that errors at the tool wrapper -- expected only when AWS isn't in
	// selectedDataSources but the supervisor dispatched anyway (bug, not silent).
	if (dataSourceId === "aws" && state.awsTargetEstates.length > 0) {
		log.info({ estates: state.awsTargetEstates }, "AWS sub-agent fanning out across estates");
		const results = await Promise.all(
			state.awsTargetEstates.map((estate) =>
				withAwsEstate(estate, () =>
					runSubAgent(state, dataSourceId, agentName, isRetry, log, config, { deploymentId: `estate:${estate}` }),
				),
			),
		);
		return { dataSourceResults: results };
	}

	if (deployments.length === 0) {
		const result = await runSubAgent(state, dataSourceId, agentName, isRetry, log, config);
		return { dataSourceResults: [result] };
	}

	log.info({ deployments, isRetry }, "Elastic sub-agent fanning out across deployments");
	// SIO-697: parallel fan-out. withElasticDeployment is backed by AsyncLocalStorage
	// (see mcp-bridge.ts), so each branch gets its own deployment context. runSubAgent
	// catches its own errors and returns a result object, so Promise.all never rejects.
	const results = await Promise.all(
		deployments.map((deploymentId) =>
			withElasticDeployment(deploymentId, () =>
				runSubAgent(state, dataSourceId, agentName, isRetry, log, config, { deploymentId }),
			),
		),
	);
	return { dataSourceResults: results };
}

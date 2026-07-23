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
import type { RunnableConfig } from "@langchain/core/runnables";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { capSubAgentTimeoutMs, getGraphDeadlineAt } from "./graph-budget.ts";
import { createLlm } from "./llm.ts";
import { getToolsForDataSource, withAwsEstate, withElasticDeployment } from "./mcp-bridge.ts";
import { extractTextFromContent } from "./message-utils.ts";
import { buildCachedSystemMessage } from "./prompt-cache.ts";
import { buildSubAgentPrompt, getToolDefinitionForDataSource } from "./prompt-context.ts";
import type { AgentStateType } from "./state.ts";
import { buildFocusBlock } from "./sub-agent-focus-block.ts";
import { instrumentTools, TYPED_FINDING_TOOLS } from "./sub-agent-instrumentation.ts";
import {
	getSubAgentStateOutputCapBytes,
	getSubAgentToolCapBytes,
	truncateToolOutput,
} from "./sub-agent-truncate-tool-output.ts";

const logger = getLogger("agent:sub-agent");

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

// SIO-689: Trace evidence on the failing pass-4 query showed 13 LLM iterations + 12 tools-node
// executions = 25 graph steps, the LangGraph default. The 33 underlying elasticsearch_* calls were
// legitimate progressive refinement (cross-deployment 5xx triage), not looping. Lift to 40 for
// elastic only (~20 LLM iterations × ~2.75 parallel tools = ~55 tool-call budget). The 5-minute
// SUB_AGENT_TIMEOUT_MS still bounds wall-clock damage on a true loop.
const ELASTIC_RECURSION_LIMIT_DEFAULT = 40;

export function getSubAgentRecursionLimit(
	dataSourceId: string,
	env: NodeJS.ProcessEnv = process.env,
): number | undefined {
	if (dataSourceId !== "elastic") return undefined;
	const raw = env.SUBAGENT_ELASTIC_RECURSION_LIMIT;
	if (raw == null || raw === "") return ELASTIC_RECURSION_LIMIT_DEFAULT;
	const parsed = Number(raw);
	if (!Number.isFinite(parsed) || parsed <= 0) return ELASTIC_RECURSION_LIMIT_DEFAULT;
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
	return String(content);
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
	atlassian: ["atlassian_search"],
	// NOTE: kafka is deliberately NOT here. Force-including kafka_list_topics would
	// reintroduce the SIO-785 regression -- the broad topic-listing tool crowds out
	// the specialized dlq_messages tools (kafka_list_dlq_topics), breaking the typed
	// KafkaFindingsCard DLQ extractor. Kafka identifier resolution is handled up-front
	// by the resolveIdentifiers node (Part B) instead, which does not touch the
	// per-action tool budget.
};

// SIO-1029: union the datasource's always-include resolution tools into a
// filtered selection (looked up from allTools by name), deduping, before the
// caller slices to MAX_TOOLS_PER_AGENT. No-op for datasources without a
// resolution set or when the tools are already present.
function withResolutionTools(
	selected: StructuredToolInterface[],
	allTools: StructuredToolInterface[],
	dataSourceId: string,
): StructuredToolInterface[] {
	const required = RESOLUTION_TOOLS_BY_DATASOURCE[dataSourceId];
	if (!required || required.length === 0) return selected;
	const present = new Set(selected.map((t) => t.name));
	const missing = required.filter((name) => !present.has(name));
	if (missing.length === 0) return selected;
	const missingSet = new Set(missing);
	const extras = allTools.filter((t) => missingSet.has(t.name));
	if (extras.length === 0) return selected;
	return [...extras, ...selected];
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
): { tools: StructuredToolInterface[]; filtered: boolean } {
	if (allTools.length <= MAX_TOOLS_PER_AGENT) {
		return { tools: allTools, filtered: false };
	}

	if (!toolDef?.tool_mapping?.action_tool_map) {
		return { tools: allTools.slice(0, MAX_TOOLS_PER_AGENT), filtered: true };
	}

	const actions = toolActions?.[dataSourceId];
	if (actions && actions.length > 0) {
		const { toolNames } = resolveActionTools(toolDef, actions);
		if (toolNames.length > 0) {
			const nameSet = new Set(toolNames);
			const selected = allTools.filter((t) => nameSet.has(t.name));
			if (selected.length >= MIN_FILTERED_TOOLS) {
				const withResolution = withResolutionTools(selected, allTools, dataSourceId);
				return { tools: withResolution.slice(0, MAX_TOOLS_PER_AGENT), filtered: true };
			}
		}
	}

	const allActionNames = getAllActionToolNames(toolDef);
	if (allActionNames.length > 0) {
		const nameSet = new Set(allActionNames);
		const selected = allTools.filter((t) => nameSet.has(t.name));
		if (selected.length >= MIN_FILTERED_TOOLS) {
			const withResolution = withResolutionTools(selected, allTools, dataSourceId);
			return { tools: withResolution.slice(0, MAX_TOOLS_PER_AGENT), filtered: true };
		}
	}

	// SIO-1084: even on the raw-slice fallback (reached when the action_tool_map
	// names don't resolve to runtime tool names -- e.g. konnect's YAML uses bare
	// `list_services` while runtime tools are `konnect_*`-prefixed), still union in
	// the datasource's resolution tools so the "where to look" enumerator is always
	// present, then slice. Guarantees the A5 invariant on every path.
	const withResolution = withResolutionTools(allTools.slice(0, MAX_TOOLS_PER_AGENT), allTools, dataSourceId);
	return { tools: withResolution.slice(0, MAX_TOOLS_PER_AGENT), filtered: true };
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
		// SIO-1040: cache the base sub-agent prompt (stable) so the up-to-40 ReAct
		// iterations and per-deployment fan-out share the Bedrock cache prefix within
		// the 5-min TTL; the per-turn investigation focus stays volatile (uncached).
		const systemPrompt = buildCachedSystemMessage(baseSystemPrompt, volatileBlock);
		const llm = createLlm("subAgent");

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

		const { tools, filtered } = selectToolsByAction(allTools, dataSourceId, augmentedToolActions, toolDef);
		log.info(
			{ toolCount: tools.length, totalTools: allTools.length, filtered, deploymentId },
			"Creating ReAct agent with tools",
		);

		// SIO-686: per-tool-result observability so we can size the cap from real traces.
		// When SUBAGENT_TOOL_RESULT_CAP_BYTES is set, oversized ToolMessage.content is
		// JSON-aware truncated before re-entering the ReAct loop.
		const capBytes = getSubAgentToolCapBytes();
		const instrumentedTools = instrumentTools(tools, { dataSourceId, deploymentId, log, capBytes, config });

		const agent = createReactAgent({
			llm,
			tools: instrumentedTools,
			messageModifier: systemPrompt,
		});

		const messages = lastUserMessage ? [lastUserMessage] : state.messages.slice(-1);

		const recursionLimit = getSubAgentRecursionLimit(dataSourceId);
		// SIO-1110: cap the timer at the remaining graph budget minus the aggregation
		// reserve so a late dispatch (alignment retry) can never starve aggregation.
		// First attempts start with ample remaining budget, so the cap never binds there.
		const baseTimeoutMs = getSubAgentTimeoutMs();
		const timeoutMs = capSubAgentTimeoutMs(baseTimeoutMs, getGraphDeadlineAt(config));
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
			...(recursionLimit !== undefined && { recursionLimit }),
		});
		const lastResponse = response.messages.at(-1);
		const duration = Date.now() - startTime;

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
				responseLength: String(lastResponse?.content ?? "").length,
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
		const toolOutputs = toolMessages.map((m: { name?: string; content: unknown }) => {
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

		// SIO-1029: a truncated run that still gathered tool data is partial-success,
		// not error -- salvage what elastic observed rather than blanking the datasource.
		// The last message on a truncated run is an AIMessage/ToolMessage mid-loop, not a
		// synthesized answer, so append an explicit note when there is no clean final text.
		const salvageNote =
			"\n\n[Note: investigation was truncated at the sub-agent recursion limit; the above reflects partial findings.]";
		const baseData = lastResponse ? String(lastResponse.content) : "No response from sub-agent";
		const data = truncated ? `${baseData}${salvageNote}` : baseData;

		return {
			dataSourceId,
			data,
			status: allToolsFailed ? "error" : "success",
			duration,
			toolOutputs,
			isAlignmentRetry: isRetry,
			messageCount: response.messages.length,
			...(deploymentId && { deploymentId }),
			...(toolErrors.length > 0 && { toolErrors }),
			...(allToolsFailed && { error: `All ${toolErrors.length} tool calls failed` }),
		};
	} catch (error) {
		const duration = Date.now() - startTime;
		log.error(
			{ duration, deploymentId, error: error instanceof Error ? error.message : String(error) },
			"Sub-agent failed",
		);
		return {
			dataSourceId,
			data: null,
			status: "error",
			duration,
			isAlignmentRetry: isRetry,
			...(deploymentId && { deploymentId }),
			error: error instanceof Error ? error.message : String(error),
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

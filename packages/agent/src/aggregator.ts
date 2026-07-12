// agent/src/aggregator.ts
import { getLogger } from "@devops-agent/observability";
import { type DataSourceResult, isDegradingCategory, redactPiiContent } from "@devops-agent/shared";
import type { BaseMessage } from "@langchain/core/messages";
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import type { RunnableConfig } from "@langchain/core/runnables";
import { summarizeFirstAttempts } from "./alignment.ts";
import { createLlm } from "./llm.ts";
import { extractTextFromContent } from "./message-utils.ts";
import { buildCachedSystemMessage } from "./prompt-cache.ts";
import { buildOrchestratorPromptParts, getActiveSkillNames } from "./prompt-context.ts";
import type { AgentStateType } from "./state.ts";
import { truncateToolOutput } from "./sub-agent-truncate-tool-output.ts";

interface AggregatorLogSink {
	info: (...args: unknown[]) => unknown;
	warn: (...args: unknown[]) => unknown;
	error: (...args: unknown[]) => unknown;
}

const defaultLogger: AggregatorLogSink = getLogger("agent:aggregator") as unknown as AggregatorLogSink;
let currentLogger: AggregatorLogSink = defaultLogger;
const logger: AggregatorLogSink = {
	info: (...args) => currentLogger.info(...args),
	warn: (...args) => currentLogger.warn(...args),
	error: (...args) => currentLogger.error(...args),
};

// SIO-691: test seam mirroring _setAlignmentLoggerForTesting. Pass null to reset.
export function _setAggregatorLoggerForTesting(sink: AggregatorLogSink | null): void {
	currentLogger = sink ?? defaultLogger;
}

// SIO-833: bound the aggregate prompt so AWS estate fan-out (one DataSourceResult per
// estate) can't scale the LLM input linearly. Each result's `data` is reduced with the
// shared JSON-aware truncator before it enters the prompt. Findings are unaffected:
// extractFindings reads toolOutputs (not r.data) and runs AFTER aggregate.
const AGGREGATE_RESULT_CAP_BYTES_DEFAULT = 32_768;
const AGGREGATE_TOTAL_CAP_BYTES_DEFAULT = 262_144;
const AGGREGATE_RESULT_CAP_FLOOR = 4_096;

function readCapEnv(raw: string | undefined, def: number): number | null {
	// Mirrors getSubAgentToolCapBytes: unset/invalid -> default, explicit "0" -> disabled.
	if (raw == null || raw === "") return def;
	const parsed = Number(raw);
	if (!Number.isFinite(parsed)) return def;
	if (parsed === 0) return null;
	if (parsed < 0) return def;
	return Math.floor(parsed);
}

function getAggregateResultCapBytes(env: NodeJS.ProcessEnv = process.env): number | null {
	return readCapEnv(env.AGGREGATE_RESULT_CAP_BYTES, AGGREGATE_RESULT_CAP_BYTES_DEFAULT);
}

function getAggregateTotalCapBytes(env: NodeJS.ProcessEnv = process.env): number | null {
	return readCapEnv(env.AGGREGATE_TOTAL_CAP_BYTES, AGGREGATE_TOTAL_CAP_BYTES_DEFAULT);
}

// Per-result byte budget: at most the per-result cap, and at most a fair slice of the
// total budget so N-estate fan-out stays bounded regardless of estate count (never below
// a usable floor). Returns null when per-result capping is disabled (AGGREGATE_RESULT_CAP_BYTES=0).
export function aggregateResultBudget(resultCount: number, env: NodeJS.ProcessEnv = process.env): number | null {
	const per = getAggregateResultCapBytes(env);
	if (per == null) return null;
	const total = getAggregateTotalCapBytes(env);
	if (total == null) return per;
	const fairShare = Math.floor(total / Math.max(1, resultCount));
	return Math.max(AGGREGATE_RESULT_CAP_FLOOR, Math.min(per, fairShare));
}

function buildAggregatorMessages(state: AgentStateType, resultsBlock: string): BaseMessage[] {
	// SIO-640: Tri-state selectedRunbooks field drives the runbook filter.
	//   null      -> no filter (preserve current behavior)
	//   []        -> filter to zero runbooks (selector chose none)
	//   [names]   -> filter to just these
	const runbookFilter = state.selectedRunbooks ?? undefined;
	// SIO-847: surface relevant compiled wiki pages by the current focus. Fall
	// back to the extracted datasources/affected services when no focus anchor
	// has been established yet.
	const wikiFocus = {
		services: state.investigationFocus?.services ?? state.normalizedIncident.affectedServices?.map((s) => s.name) ?? [],
		datasources: state.investigationFocus?.datasources ?? state.targetDataSources,
	};
	// SIO-1040: split the orchestrator prompt so the stable core (soul + rules +
	// skills) is a Bedrock cache prefix and the volatile suffix (filtered
	// knowledge + memory + wiki + graph) stays uncached.
	const promptParts = buildOrchestratorPromptParts({ runbookFilter, wikiFocus, graphContext: state.graphContext });
	const priorAnswer = state.finalAnswer;
	const lastUserMessage = state.messages.filter((m) => m._getType() === "human").pop();
	const userQuery = lastUserMessage ? extractTextFromContent(lastUserMessage.content) : "";

	// Only mention datasources that were actually queried
	const queriedSources = state.targetDataSources;
	const scopeNote =
		queriedSources.length > 0
			? `\n\nIMPORTANT: Only the following datasources were queried for this report: ${queriedSources.join(", ")}. Do NOT mention, list, or create sections for datasources that were not queried. The user explicitly selected these datasources -- omitting others is intentional, not a gap.`
			: "";

	// SIO-626: Surface unavailable datasources so the report explicitly mentions gaps
	const skipped = state.skippedDataSources ?? [];
	const unavailableNote =
		skipped.length > 0
			? `\n\nUNAVAILABLE DATASOURCES: ${skipped.join("; ")}. Include these in a "Gaps" section of the report so the user knows which datasources could not be reached.`
			: "";

	// Datasources that return point-in-time state (not timestamped events) should not
	// be penalized in the confidence score for lacking a timeline.
	const STATUS_ORIENTED_SOURCES = new Set(["kafka", "couchbase", "konnect", "atlassian"]);
	const hasEventSources = queriedSources.some((s) => !STATUS_ORIENTED_SOURCES.has(s));
	const timelineGuidance = hasEventSources
		? ""
		: `\n\nTIMELINE GUIDANCE: The queried datasources (${queriedSources.join(", ")}) return infrastructure state snapshots, not timestamped event logs. A correlated timeline is not expected for these sources. Do not penalize the confidence score for the absence of timestamps or timeline data. If no event-log datasources (e.g. elastic) were queried, omit the correlated timeline section entirely.`;

	// When tool errors indicate connectivity problems, instruct the LLM to lead with that
	const failedSources = state.dataSourceResults.filter((r) => r.toolErrors && r.toolErrors.length > 0);
	const connectivityGuidance =
		failedSources.length > 0
			? `\n\nTOOL FAILURE GUIDANCE: ${failedSources.length} datasource(s) reported tool errors. When tool errors show repeated metadata/connection failures, the report summary must lead with the infrastructure connectivity problem (e.g. "brokers are unreachable") as the primary finding. Do not present connectivity failure as one possibility among equals -- state it as the leading diagnosis and list other causes as secondary.`
			: "";

	// SIO-649: When elastic fans out across multiple deployments, each result carries a
	// deploymentId. The LLM must produce per-deployment findings rather than collapsing
	// them into a single "elastic" section, otherwise distinct clusters get merged.
	const elasticDeployments = [
		...new Set(
			state.dataSourceResults.filter((r) => r.dataSourceId === "elastic" && r.deploymentId).map((r) => r.deploymentId),
		),
	];
	const perDeploymentGuidance =
		elasticDeployments.length > 1
			? `\n\nMULTI-DEPLOYMENT ELASTIC GUIDANCE: The elastic data source was queried across ${elasticDeployments.length} distinct deployments (${elasticDeployments.join(", ")}). Each "### elastic/<deploymentId>" section below is a DIFFERENT Elasticsearch cluster with its own nodes, shards, and metrics. In the findings section, produce a separate sub-section per deployment -- do NOT merge them into a single "Elastic" summary. Node IDs, instance names, and metrics from one deployment are not applicable to others. In the executive summary, identify issues per-deployment (e.g. "eu-cld: heap pressure; us-cld-monitor: healthy").`
			: "";

	// SIO-856: scope AWS claims to the estates ACTUALLY assessed (state.awsTargetEstates),
	// not the full configured set. The AWS sub-agent calls aws_list_estates, whose output
	// lists every configured estate with boot-time STS health -- without this note the LLM
	// over-generalizes "7 configured & reachable" into "all 7 accounts healthy" even when a
	// single estate was selected. Mirrors the elastic per-deployment guidance above.
	const assessedEstates = state.awsTargetEstates ?? [];
	const awsEstateScopeGuidance =
		assessedEstates.length > 0
			? `\n\nAWS ESTATE SCOPE: This investigation assessed ONLY the following AWS estate(s): ${assessedEstates.join(", ")}. Every AWS finding below is from ${assessedEstates.length === 1 ? "this estate" : "these estates"} alone. Do NOT claim health, coverage, or status for any other AWS account or estate. If aws_list_estates output appears in the data, it lists the runtime's CONFIGURED estates for routing -- it is NOT a statement that those estates were assessed; never write "all N accounts are healthy" based on it. In the report header and executive summary, state the assessed estate(s) explicitly and scope all conclusions to ${assessedEstates.length === 1 ? "it" : "them"}.`
			: "";

	const messages: BaseMessage[] = [buildCachedSystemMessage(promptParts.stable, promptParts.volatile)];

	// On follow-ups with a prior answer, provide it as condensed context instead of
	// replaying the full conversation history (which can exceed token limits)
	if (priorAnswer) {
		messages.push(
			new HumanMessage(
				`Previous analysis (for context -- do not repeat verbatim, only reference or update relevant sections):\n\n${priorAnswer}`,
			),
		);
	}

	if (userQuery) {
		messages.push(new HumanMessage(`Current query: ${userQuery}`));
	}

	// SIO-632: Strict confidence format the regex below can always find. The HITL gate reads
	// the parsed score -- if this is omitted, the gate treats the report as 0 confidence and
	// may surface it as low-confidence to the user, which is worse than a real score.
	const confidenceFormatRule = `\n\nCONFIDENCE LINE REQUIREMENT: End the report with a line in this EXACT format on its own line: "Confidence: 0.XX" where 0.XX is a decimal between 0.0 and 1.0 (e.g. "Confidence: 0.82"). This line MUST be present. Do not use percentages, ranges, or qualitative words like "high"/"medium"/"low" -- a parseable decimal is required for downstream routing.`;

	// SIO-711: The styles-v3 aggregator volunteered "not fabricated" -- a meta-signal
	// that the LLM perceived a non-trivial risk a reader would suspect fabrication.
	// Forbid the self-defensive register; require structured "[partial: <field>]"
	// markers instead, which lower confidence mechanically (the markers correlate
	// with the Gaps cap from SIO-709 AC #2). Also pin the Gaps heading to a plain
	// "## Gaps" so the deterministic SIO-709 parser reliably matches the LLM's
	// output rather than silently missing bold/compound headings.
	const defensiveProseRule = `\n\nDEFENSIVE PROSE FORBIDDEN: Do not editorialise about whether your output is fabricated, hallucinated, or trustworthy. Phrases like "not fabricated", "I am not hallucinating", "this is reliable", or "based on real data" are banned. If a value or finding is uncertain, do one of: (a) emit a "[partial: <field-name>]" marker inline where the value would go, (b) list the missing data in the Gaps section, or (c) lower your confidence score. Never reassure the reader in prose -- structured markers and the Gaps section are the only acceptable channels for uncertainty. When listing gaps, use exactly the heading "## Gaps" (no bold, no extra words, no colon) so downstream tooling can parse the section reliably.`;

	// SIO-1031: the LLM fabricated a "logs:DescribeLogGroups IAM gap persists" blocker with no tool
	// having returned AccessDenied. A permission/IAM claim MUST be grounded in an observed auth tool
	// error, never inferred from missing data. Aligns the model with detectUngroundedBlockers.
	const groundedBlockerRule = `\n\nGROUNDED BLOCKERS ONLY: Only describe a datasource as permission-blocked or write "IAM gap" / "not permitted" / a named IAM action as a cause if a tool call in THIS investigation returned an authorization error. If data is simply absent with no observed auth error, state that the data was not retrieved and the access state is unconfirmed -- do NOT name an IAM action or assert a permission gap you did not observe.`;

	// SIO-742: when a *_health_check tool returned status:"up" for a Confluent
	// component (REST Proxy, ksqlDB, Kafka Connect, Schema Registry), do NOT list
	// that component as a gap. Gaps is for missing data; a confirmed-up health
	// probe is the OPPOSITE of missing data. This stops the Gaps-cap loop where
	// healthy components fill the Gaps section and pin confidence below 0.6.
	const healthCheckGapRule = `\n\nHEALTH-CHECK GAPS RULE: If a *_health_check or ksql_cluster_status tool returned status:"up" for a component, do NOT list that component under "## Gaps". Do NOT write "REST Proxy NOT DETECTED" or "deployment status is unconfirmed" for a component whose health-check returned up. Gaps is reserved for genuinely missing data, never for components that were probed and found healthy.`;

	// SIO-1059: the Couchbase PrivateLink report paired a cumulative-time figure (38m47s, from the
	// expensive-query tool, count 1,829) with an execution count from a DIFFERENT tool row (2,604,
	// from the frequency tool), and attached an engine "~analysis" flag ("filter eliminating over
	// 90%") from one query onto a different query (53% pass rate). Every scalar must come from the
	// SAME tool row as the other scalars cited alongside it.
	const numericGroundingRule = `\n\nNUMERIC PROVENANCE: When you cite several numbers about one query/entity (execution count, cumulative time, average, result count, fetch/pass rate), they MUST all come from the SAME tool-output row. Do NOT pair a count from one tool with a cumulative/average from another -- e.g. an execution count from a "most_frequent_queries" row does not describe the cumulative time in a "most_expensive_queries" row, even for the same-looking statement. When you quote an engine analysis flag (e.g. "filter eliminating over 90%", "high fetch count"), it MUST belong to the exact query row you are describing; never transfer a flag from one query to another. If two rows cannot be confirmed as the same query, report them separately rather than merging their numbers.`;

	// SIO-1059: the report asserted an AWS Health EC2 lifecycle event (in one of our accounts) as
	// the causal TRIGGER for a Couchbase Capella node rotation -- but Capella runs in the vendor's
	// own AWS account (its fleet never surfaces in our Health console) and the incident timeline
	// predated the event. An event observed in one account/vendor cannot be asserted as the cause
	// of infrastructure managed in another.
	const causalGroundingRule = `\n\nCAUSAL SCOPING: Do NOT assert an event observed in one account or one vendor's control plane as the CAUSE of a failure in infrastructure managed by a different account or vendor (e.g. an AWS Health event in our estate "triggering" a change on a third-party-managed service like Couchbase Capella, Confluent Cloud, or Kong Konnect). Such a link is at most a candidate correlation to confirm via that vendor's console/support -- phrase it as "candidate correlation, unconfirmed" and never place it as the head of a causal chain. Also check direction of time: an event that occurred AFTER the onset it supposedly caused is not the trigger.`;

	// SIO-750: when an investigation focus is established AND we have a prior
	// answer, replace the loose "do not repeat the full prior report" framing
	// with continuation-aware guidance that names the anchored services + time
	// window. This is the line that previously let the LLM frame turn 2 as
	// "supersedes the prior analysis" and pivot to unrelated clusters.
	const focus = state.investigationFocus;
	const continuationGuidance =
		priorAnswer && focus
			? `\n\nIMPORTANT: We are CONTINUING the "${focus.summary}" investigation. The anchored services are ${focus.services.join(", ") || "(none specified)"} and the anchored time window is ${focus.timeWindow ? `${focus.timeWindow.from} to ${focus.timeWindow.to}` : "(none specified)"}. Update the prior report's relevant sections with new findings; do NOT start a fresh report or claim it "supersedes" the prior one. If the user's current message is a focused question (e.g. "is X still failing?"), answer it directly with reference to the anchored entities rather than introducing new ones.`
			: priorAnswer
				? `\n\nIMPORTANT: Focus on answering the current query. Reference prior findings where relevant but do not repeat the full prior report.`
				: "";

	messages.push(
		new HumanMessage(
			`Aggregate these datasource findings into a unified incident report. Only reference data present below -- do not fabricate metrics or timestamps.${scopeNote}${unavailableNote}${timelineGuidance}${connectivityGuidance}${perDeploymentGuidance}${awsEstateScopeGuidance}${confidenceFormatRule}${defensiveProseRule}${groundedBlockerRule}${healthCheckGapRule}${numericGroundingRule}${causalGroundingRule}\n\nReport generation timestamp: ${new Date().toISOString()}. Use this exact value as the "Generated" date in the report header. Do not invent a different timestamp.\n\nIf no specific timestamps are available from the datasource findings (i.e., all observations are current-state snapshots rather than timestamped events), use "Current State Assessment" as the section heading instead of "Correlated Timeline", and use "Current" in the time column instead of fabricating timestamps.\n\n${resultsBlock}\n\nProvide: summary, ${hasEventSources ? "correlated timeline (markdown table), " : ""}findings per datasource${elasticDeployments.length > 1 ? " (with per-deployment sub-sections for elastic)" : ""}, confidence score (0.0-1.0), and any gaps.${continuationGuidance}`,
		),
	);

	return messages;
}

// Strict form: a line containing "Confidence:" or "**Confidence:**" or "Confidence Score:",
// followed by a decimal. Anchored to line start (with optional markdown bullets / bold) so
// it only matches a dedicated confidence line, not prose like "I'm confident in X 9.3".
const STRICT_CONFIDENCE_RE = /^\s*[*_>\-\s]*\**\s*confidence(?:\s+score)?\s*:?\**\s*([0-1](?:\.\d+)?)/im;
// Loose fallback: old pattern, but we additionally require the number to be in [0, 1].
const LOOSE_CONFIDENCE_RE = /confidence[^0-9]{0,20}([0-9]+(?:\.[0-9]+)?)/i;

function extractConfidenceScore(answer: string): number {
	const strict = answer.match(STRICT_CONFIDENCE_RE);
	if (strict) {
		const n = Number.parseFloat(strict[1] ?? "");
		if (Number.isFinite(n) && n >= 0 && n <= 1) return n;
	}
	const loose = answer.match(LOOSE_CONFIDENCE_RE);
	if (loose) {
		const n = Number.parseFloat(loose[1] ?? "");
		// Only accept fallback matches that look like a valid confidence score (0-1, not an index/version).
		if (Number.isFinite(n) && n >= 0 && n <= 1) return n;
	}
	return 0;
}

// SIO-860: rewrite the dedicated "Confidence:" line in the report to `score` so the
// printed value matches the gate's confidenceScore. Without this the LLM's pre-cap
// prose (e.g. 0.90) contradicts a capped gate value (0.59), firing a low_confidence
// banner on a report that visibly reads 0.90. Reuses the same line-anchored regexes
// as extractConfidenceScore so it rewrites exactly the line that was read. Only the
// captured number is replaced; surrounding markup ("**Confidence:**") is preserved.
// No confidence line present -> answer returned unchanged (gate still uses the number).
export function rewriteConfidenceInAnswer(answer: string, score: number): string {
	const formatted = String(score);
	const replaceCapturedNumber = (match: string, captured: string): string => {
		const idx = match.lastIndexOf(captured);
		if (idx === -1) return match;
		return match.slice(0, idx) + formatted + match.slice(idx + captured.length);
	};
	if (STRICT_CONFIDENCE_RE.test(answer)) {
		return answer.replace(STRICT_CONFIDENCE_RE, (m, captured: string) => replaceCapturedNumber(m, captured));
	}
	if (LOOSE_CONFIDENCE_RE.test(answer)) {
		return answer.replace(LOOSE_CONFIDENCE_RE, (m, captured: string) => replaceCapturedNumber(m, captured));
	}
	return answer;
}

// SIO-709: Count top-level bullet items under a "Gaps" heading. Triggers the 0.59
// cap when the LLM lists >= 2 missing-data items in its own report. Indented
// sub-bullets (>= 2 leading spaces) are excluded so a structurally rich gap with
// sub-points doesn't inflate the count beyond the user's mental model.
const GAPS_HEADING_RE = /^#{1,6}\s+gaps\s*$/im;
const TOP_LEVEL_BULLET_RE = /^\s{0,1}[-*]\s+\S/;
const ANY_HEADING_RE = /^#{1,6}\s+\S/;
// SIO-1054: the Recommendations section (## Recommendations) is where the ungrounded IAM
// prescription surfaces. Unlike Gaps it contains ### sub-headings (Investigate / Monitor /
// Escalate), so the grounding scan must stay "inside" it until the next same-or-higher-level
// heading, not break on the first ### sub-heading.
const RECOMMENDATIONS_HEADING_RE = /^#{1,6}\s+recommendations\s*$/im;
// Match the heading level (number of leading #) so we can decide whether a heading ends the
// current section (same-or-shallower) or is a sub-heading within it (deeper).
function headingLevel(line: string): number | null {
	const m = line.match(/^(#{1,6})\s+\S/);
	return m?.[1] ? m[1].length : null;
}

export function extractGapsBulletCount(answer: string): number {
	const lines = answer.split("\n");
	let inGapsSection = false;
	let count = 0;
	for (const line of lines) {
		if (inGapsSection && ANY_HEADING_RE.test(line)) break;
		if (!inGapsSection && GAPS_HEADING_RE.test(line)) {
			inGapsSection = true;
			continue;
		}
		if (inGapsSection && TOP_LEVEL_BULLET_RE.test(line)) {
			count += 1;
		}
	}
	return count;
}

// SIO-1013: a Gaps bullet asserting a permission/IAM denial must be grounded in an
// observed auth tool error. A real logs:DescribeLogGroups AccessDenied flows
// MCP _error.kind=iam-permission-missing -> tool output text -> sub-agent.ts regex
// (/access denied/i, /forbidden/i) -> toolErrors[{category:"auth"}]. If the gap claims a
// denial but NO auth error exists in any sub-agent's results, the LLM fabricated it.
// Note: the `logs:[a-z]+` arm was intentionally removed — an informational mention of a
// logs: action (e.g. "logs:DescribeLogGroups returned 12 groups") must not count as a
// denial. Only explicit denial phrases trigger the grounding check.
// SIO-1031: the LLM writes "IAM gap persists" / "IAM access" for fabricated blockers, which the
// original `iam permission` arm missed. `iam (?:permission|gap|access)` catches that denial
// phrasing while staying narrow — it never fires on a bare action name.
const PERMISSION_DENIAL_RE =
	/\b(not permitted|not authorized|unauthorized|access denied|accessdenied|forbidden|iam (?:permission|gap|access)|permission (?:gap|denied|missing)|lacks? permission)\b/i;

// SIO-1054: the Recommendations section fabricates a *prescription* rather than a *denial*:
// "add `logs:DescribeLogGroups` to `DevOpsAgentReadOnlyPolicy` per the IAM runbook". That text
// matches none of PERMISSION_DENIAL_RE (there is no denial verb), so the denial detector alone
// would miss the exact bullet we are hunting. This catches a policy-edit prescription that names
// the read-only policy or the IAM runbook, or an "update/add ... policy to include <action>"
// instruction -- all of which are only legitimate when a real authz error was observed.
const IAM_PRESCRIPTION_RE =
	/\b(devopsagentreadonly|iam runbook|(?:add|update|grant|include|attach)[^.\n]{0,60}\b(?:policy|permission|iam)\b|(?:policy|permission)[^.\n]{0,40}\bto include\b)/i;

// SIO-1054: scan both "## Gaps" and "## Recommendations" for ungrounded permission-denial
// bullets. A section runs from its heading until the next heading of the same-or-shallower
// level (so ### Investigate/Monitor/Escalate sub-headings inside Recommendations stay in
// scope). A permission-denial bullet found in either section, with NO observed auth tool
// error, is fabricated.
export function detectUngroundedBlockers(answer: string, results: DataSourceResult[]): { ungrounded: string[] } {
	const authErrorObserved = results.some((r) => (r.toolErrors ?? []).some((e) => e.category === "auth"));
	if (authErrorObserved) return { ungrounded: [] };

	const lines = answer.split("\n");
	const ungrounded: string[] = [];
	// Level of the heading that opened the current in-scope section, or null when outside one.
	let sectionLevel: number | null = null;
	for (const line of lines) {
		const level = headingLevel(line);
		if (level !== null) {
			if (sectionLevel !== null && level <= sectionLevel) {
				// A heading at the same or shallower level ends the current section...
				sectionLevel = null;
			}
			// ...and any heading (including the terminator) may itself open a new section.
			if (GAPS_HEADING_RE.test(line) || RECOMMENDATIONS_HEADING_RE.test(line)) {
				sectionLevel = level;
			}
			continue;
		}
		if (
			sectionLevel !== null &&
			TOP_LEVEL_BULLET_RE.test(line) &&
			(PERMISSION_DENIAL_RE.test(line) || IAM_PRESCRIPTION_RE.test(line))
		) {
			ungrounded.push(line);
		}
	}
	return { ungrounded };
}

// SIO-1013: replace each ungrounded permission-blocker bullet's fabricated cause with a
// neutral truth. We do not know WHY the data is missing (the tool may simply never have
// been called), so we assert only what is verifiable: the data was not retrieved and the
// access state is unconfirmed. Only the flagged lines change; the rest of the report is
// preserved verbatim.
const UNGROUNDED_BLOCKER_REPLACEMENT =
	"- Some data referenced above were not retrieved during this investigation. No permission error was observed, so the access state is unconfirmed; the relevant read tools may not have been invoked.";

export function rewriteUngroundedBlockers(answer: string, ungrounded: string[]): string {
	if (ungrounded.length === 0) return answer;
	const flagged = new Set(ungrounded);
	return answer
		.split("\n")
		.map((line) => (flagged.has(line) ? UNGROUNDED_BLOCKER_REPLACEMENT : line))
		.join("\n");
}

// SIO-1079: the aggregator hallucinated "CloudWatch logs are expired (80-day retention
// exceeded)" from a MalformedQueryException -- a QUERY-WINDOW error, not evidence of expiry.
// The raw CloudWatch message literally contains the word "retention", which leads the LLM to
// this false conclusion. Live A/B (eu-oit-prd, retentionInDays=60) proved the logs existed
// and a correctly-anchored query returned them. This guard mirrors the IAM guard above but is
// scoped to expiry/retention claims: a "logs expired / retention exceeded / data expired"
// gap bullet is fabricated UNLESS an actual absence/expiry was observed.
const EXPIRY_CLAIM_RE =
	/\b(logs? (?:are |were )?expired|(?:log )?retention (?:exceeded|window exceeded|policy exceeded)|data (?:is |was )?expired|logs? (?:are |were )?(?:no longer|not) (?:available|retained)|beyond (?:the )?retention)\b/i;

// A genuine absence/expiry signal: a describe/list tool that actually reported the group or
// data absent (empty result / no such group). When observed, an "expired/absent" claim is
// grounded and must NOT be rewritten. Kept deliberately narrow so a mere query-window error
// (which does NOT observe absence) never satisfies it.
const OBSERVED_ABSENCE_RE =
	/\b(no such log group|logGroups:?\s*\[\s*\]|no log groups found|ResourceNotFound|log group .* does not exist)\b/i;

function expiryObserved(results: DataSourceResult[]): boolean {
	return results.some((r) => {
		const data = typeof r.data === "string" ? r.data : JSON.stringify(r.data ?? "");
		return OBSERVED_ABSENCE_RE.test(data);
	});
}

export function detectUngroundedExpiry(answer: string, results: DataSourceResult[]): { ungrounded: string[] } {
	if (expiryObserved(results)) return { ungrounded: [] };

	const lines = answer.split("\n");
	const ungrounded: string[] = [];
	let sectionLevel: number | null = null;
	for (const line of lines) {
		const level = headingLevel(line);
		if (level !== null) {
			if (sectionLevel !== null && level <= sectionLevel) sectionLevel = null;
			if (GAPS_HEADING_RE.test(line) || RECOMMENDATIONS_HEADING_RE.test(line)) sectionLevel = level;
			continue;
		}
		if (sectionLevel !== null && TOP_LEVEL_BULLET_RE.test(line) && EXPIRY_CLAIM_RE.test(line)) {
			ungrounded.push(line);
		}
	}
	return { ungrounded };
}

// The query-window truth: a MalformedQueryException means the window was outside retention,
// not that the data is gone. We assert only what is verifiable -- the logs were not
// retrieved and the queried window may have been outside retention -- and steer to re-anchoring.
const UNGROUNDED_EXPIRY_REPLACEMENT =
	"- CloudWatch logs were not retrieved during this investigation. The query returned a window error (the requested time range was likely outside the log group's retention window), which does NOT confirm the logs are expired or absent; re-anchoring the query to the incident time is required to confirm availability.";

export function rewriteUngroundedExpiry(answer: string, ungrounded: string[]): string {
	if (ungrounded.length === 0) return answer;
	const flagged = new Set(ungrounded);
	return answer
		.split("\n")
		.map((line) => (flagged.has(line) ? UNGROUNDED_EXPIRY_REPLACEMENT : line))
		.join("\n");
}

// SIO-1085: two premature-conclusion failure modes, one guard.
//
// (A) CONTRADICTED absence: the report says a service is "not present" / "0 hits" /
//     "does not ship logs" for a datasource whose OWN sub-agent actually returned data
//     this turn (the elastic false-negative: agent fetched 91 hits then wrote "absent").
// (B) OVER-GENERALIZED absence: the report makes a sweeping "absent from ALL records" /
//     "entirely absent" / "no ... anywhere" / "whole pipeline empty" claim. Such claims
//     are unverifiable from a partial query (the couchbase case: it queried 1 of several
//     seasonal scopes -- seasons.dates/delivery_dates hold data -- then generalized
//     "afs absent from all records"). We do not know the claim is FALSE, only that it is
//     UNGROUNDED as stated, so we soften it to the scoped truth rather than deleting it.
//
// Both are caught by scanning report lines; the rewrite makes the claim honest (scoped to
// what was actually queried) and the caller caps confidence below the HITL gate.

// A datasource-wide ABSENCE assertion (the service/data isn't there at all).
const ABSENCE_CLAIM_RE =
	/\b(not present|does not (?:ship|exist)|no (?:matching )?(?:documents?|hits|records?|logs?)\b|0 hits|zero hits|not onboarded|not shipped|no data for)\b/i;

// A SWEEPING quantifier that turns a partial observation into a universal claim.
const OVERGENERALIZED_RE =
	/\b(all records|all documents|every (?:record|document)|entirely absent|absent from all|no .{0,30}\banywhere\b|whole pipeline|entire pipeline|never (?:populated|written|loaded)|no .{0,40}\bat all\b)\b/i;

// True when a datasource's sub-agent returned NON-TRIVIAL data this turn: typed findings
// present, OR a tool output whose payload is a non-empty array / has hits / non-empty rows.
// Deliberately conservative -- only counts clear data, so a genuinely empty datasource is
// never falsely credited with data.
function dataSourceReturnedData(r: DataSourceResult): boolean {
	const findings = [r.elasticFindings, r.kafkaFindings, r.couchbaseFindings, r.gitlabFindings].filter(Boolean);
	for (const f of findings) {
		if (f && typeof f === "object" && Object.values(f).some((v) => Array.isArray(v) && v.length > 0)) return true;
	}
	for (const out of r.toolOutputs ?? []) {
		const raw = out.rawJson;
		if (Array.isArray(raw) && raw.length > 0) return true;
		if (raw && typeof raw === "object") {
			const o = raw as Record<string, unknown>;
			const hits = (o.hits as { hits?: unknown[] } | undefined)?.hits;
			if (Array.isArray(hits) && hits.length > 0) return true;
			if (Array.isArray(o.results) && o.results.length > 0) return true;
			if (typeof o.total === "number" && o.total > 0) return true;
		}
		// String tool outputs: a real elastic hit renders as "Total results: N" with N>0.
		if (typeof raw === "string") {
			const m = raw.match(/Total results:\s*([0-9]+)/i);
			if (m?.[1] && Number.parseInt(m[1], 10) > 0) return true;
		}
	}
	return false;
}

// Datasource ownership of a report line: which sub-agent's data would ground/contradict it.
// A line naming a datasource keyword is checked against THAT datasource's result.
const DATASOURCE_KEYWORDS: Record<string, RegExp> = {
	elastic: /\b(elastic|elasticsearch|logs-apm|service\.name|apm)\b/i,
	couchbase: /\b(couchbase|capella|scope|collection|seasonal_assignment|n1ql|sql\+\+)\b/i,
	kafka: /\b(kafka|topic|consumer group|partition|offset)\b/i,
};

export function detectPrematureAbsence(
	answer: string,
	results: DataSourceResult[],
): { contradicted: string[]; overgeneralized: string[] } {
	const dataByDs = new Map<string, boolean>();
	for (const r of results) {
		dataByDs.set(r.dataSourceId, (dataByDs.get(r.dataSourceId) ?? false) || dataSourceReturnedData(r));
	}
	const contradicted: string[] = [];
	const overgeneralized: string[] = [];
	for (const line of answer.split("\n")) {
		if (headingLevel(line) !== null) continue;
		const isAbsence = ABSENCE_CLAIM_RE.test(line);
		const isSweeping = OVERGENERALIZED_RE.test(line);
		if (!isAbsence && !isSweeping) continue;
		// (A) contradicted: an absence line about a datasource that returned data.
		if (isAbsence) {
			for (const [ds, kw] of Object.entries(DATASOURCE_KEYWORDS)) {
				if (kw.test(line) && dataByDs.get(ds)) {
					contradicted.push(line);
					break;
				}
			}
		}
		// (B) over-generalized: a sweeping absence/completeness claim (any datasource).
		if (isSweeping && (isAbsence || /\b(absent|empty|missing|no )\b/i.test(line))) {
			if (!contradicted.includes(line)) overgeneralized.push(line);
		}
	}
	return { contradicted, overgeneralized };
}

const CONTRADICTED_ABSENCE_SUFFIX =
	" [CORRECTION: this datasource's sub-agent returned matching data this turn, so it is NOT absent -- the earlier phrasing was a synthesis error; treat the returned data as ground truth.]";
const OVERGENERALIZED_ABSENCE_SUFFIX =
	" [SCOPE: this states absence more broadly than was verified -- it holds only for the specific collection/index/window actually queried, not the whole namespace; other scopes/collections may hold the data and were not all checked.]";

export function rewritePrematureAbsence(answer: string, contradicted: string[], overgeneralized: string[]): string {
	if (contradicted.length === 0 && overgeneralized.length === 0) return answer;
	const contra = new Set(contradicted);
	const over = new Set(overgeneralized);
	return answer
		.split("\n")
		.map((line) => {
			if (contra.has(line)) return line + CONTRADICTED_ABSENCE_SUFFIX;
			if (over.has(line)) return line + OVERGENERALIZED_ABSENCE_SUFFIX;
			return line;
		})
		.join("\n");
}

// SIO-1087 (Fix D): a confident POSITIVE root-cause MECHANISM claim that no tool output supports.
// The prana-order-service report asserted "Couchbase schema field-name mismatch" and "AWS epoch-0
// log-group metadata corruption" -- both narrated on top of query FAILURES, neither observed in any
// returned document/row. The existing guards catch ABSENCE over-claims; this catches fabricated
// PRESENCE-of-mechanism claims. Mirrors detectUngroundedExpiry: scan the Root Cause section, flag a
// specific-mechanism line, and soften (not delete -- "ungrounded as stated" != proven false) unless
// a tool output actually returned data that could carry the evidence.
const ROOT_CAUSE_HEADING_RE = /^#{1,6}\s+root cause/im;

// Specific mechanism claims that require observed evidence (a returned schema/document/error), not
// just a query that failed. Deliberately narrow (like SIO-1013's PERMISSION_DENIAL_RE) to avoid
// over-firing on legitimate, evidence-backed root causes.
const UNGROUNDED_MECHANISM_RE =
	/\b(schema mismatch|field names? (?:do not|don't|does not|doesn't) exist|wrong field names?|metadata corruption|epoch[- ]?0|corrupt(?:ed)? metadata|schema (?:drift|change) )\b/i;

export function detectUngroundedRootCause(answer: string, results: DataSourceResult[]): { ungrounded: string[] } {
	// If ANY datasource actually returned data this turn, a mechanism claim could plausibly be
	// grounded in it -- do not flag (conservative, mirrors detectUngroundedExpiry's expiryObserved).
	const anyDataReturned = results.some((r) => dataSourceReturnedData(r));
	if (anyDataReturned) return { ungrounded: [] };

	const lines = answer.split("\n");
	const ungrounded: string[] = [];
	let sectionLevel: number | null = null;
	for (const line of lines) {
		const level = headingLevel(line);
		if (level !== null) {
			if (sectionLevel !== null && level <= sectionLevel) sectionLevel = null;
			if (ROOT_CAUSE_HEADING_RE.test(line)) sectionLevel = level;
			continue;
		}
		if (sectionLevel !== null && UNGROUNDED_MECHANISM_RE.test(line)) {
			ungrounded.push(line);
		}
	}
	return { ungrounded };
}

const UNGROUNDED_ROOT_CAUSE_SUFFIX =
	" [UNVERIFIED: this specific mechanism was not observed in any returned document/row/error this turn -- the queries against the relevant datasource FAILED rather than returning contradicting data, so this root cause is inferred, not confirmed. Confirm by retrieving the actual schema/records before acting on it.]";

export function rewriteUngroundedRootCause(answer: string, ungrounded: string[]): string {
	if (ungrounded.length === 0) return answer;
	const flagged = new Set(ungrounded);
	return answer
		.split("\n")
		.map((line) => (flagged.has(line) ? line + UNGROUNDED_ROOT_CAUSE_SUFFIX : line))
		.join("\n");
}

export async function aggregate(state: AgentStateType, config?: RunnableConfig): Promise<Partial<AgentStateType>> {
	const results = state.dataSourceResults;

	// SIO-1018: capture the active skills for the confidence feedback loop. Best-effort:
	// a failure leaves it null (== "not captured"), never blocking the report.
	let skillsApplied: string[] | null = null;
	try {
		skillsApplied = getActiveSkillNames();
	} catch {
		skillsApplied = null;
	}

	if (results.length === 0) {
		logger.warn("No datasource results to aggregate");
		return {
			messages: [new AIMessage({ content: "No datasource results to aggregate." })],
			finalAnswer: "No datasource results to aggregate.",
			skillsApplied,
		};
	}

	const summary = results.map((r) => ({
		dataSourceId: r.dataSourceId,
		status: r.status,
		duration: r.duration,
		dataLength: r.status === "success" ? String(r.data).length : 0,
	}));
	logger.info({ resultCount: results.length, results: summary }, "Aggregating datasource results");

	// SIO-691: surface first-attempt failures masked by silent retries. The conditional
	// keeps clean runs quiet -- the line only appears when at least one datasource had
	// a first-attempt error, so a tail of the eval log distinguishes "succeeded first
	// try" from "failed first try, retry recovered" without scanning the whole run.
	const firstAttempts = summarizeFirstAttempts(results);
	const firstAttemptFailureCount = firstAttempts.filter((f) => f.firstStatus === "error").length;
	const recoveredCount = firstAttempts.filter((f) => f.recovered).length;
	if (firstAttemptFailureCount > 0) {
		logger.info(
			{ firstAttemptFailureCount, recoveredCount, firstAttempts },
			"First-attempt sub-agent failures masked by retry",
		);
	}

	// SIO-833: per-result byte budget bounds the prompt under AWS estate fan-out.
	const perResultCap = aggregateResultBudget(results.length);
	const resultsBlock = results
		.map((r) => {
			const status = r.status === "success" ? "OK" : `ERROR: ${r.error ?? "unknown"}`;
			const rawData = r.status === "success" ? String(r.data) : "No data";
			const data = perResultCap == null ? rawData : truncateToolOutput(rawData, perResultCap).content;
			// SIO-649: include deploymentId so the LLM distinguishes per-deployment results
			// when the elastic sub-agent fans out across multiple deployments
			const label = r.deploymentId ? `${r.dataSourceId}/${r.deploymentId}` : r.dataSourceId;
			const header = `### ${label} [${status}] (${r.duration ?? 0}ms)`;

			// Surface tool-level errors so the LLM can distinguish "some tools failed"
			// from "all tools failed" and identify the failure pattern (auth, connectivity, etc.)
			const toolErrorBlock =
				r.toolErrors && r.toolErrors.length > 0
					? `\n\nTool errors (${r.toolErrors.length} failures):\n${r.toolErrors
							.map((e) => `- ${e.toolName} [${e.category}]: ${e.message}`)
							.join("\n")}`
					: "";

			return `${header}${toolErrorBlock}\n${data}`;
		})
		.join("\n\n");

	const llm = createLlm("aggregator");
	const messages = buildAggregatorMessages(state, resultsBlock);

	logger.info("Invoking LLM for aggregation");
	const startTime = Date.now();
	const response = await llm.invoke(messages, config);

	const rawAnswer = String(response.content);
	const answer = redactPiiContent(rawAnswer);

	// SIO-632 / SIO-649: Extract confidence score for the HITL gate. The prompt now requires
	// a strict "Confidence: 0.XX" line, but we try the old loose pattern as a fallback for
	// when the LLM slips (older checkpoints, response truncation). Both paths reject values
	// outside [0, 1] so in-prose mentions like "confident in version 9.3.3" can't bleed in.
	const confidenceScore = extractConfidenceScore(answer);

	// SIO-709 (extends SIO-707): cap confidence when any sub-agent's tool-error rate
	// exceeds 15%. The styles-v3 transcript had kafka at 9/40 (22.5%) and elastic at
	// 4/27 (14.8%) -- the 25% threshold from SIO-707 missed both. The LLM may produce
	// a high score even when a sub-agent had material tool failures because the prose
	// still reads coherently; this is a deterministic guardrail. Reuses the cap value
	// from correlation/enforce-node.ts for consistency.
	const TOOL_ERROR_RATE_THRESHOLD = 0.15;
	// SIO-709 AC #4: cap must be strictly below the HITL threshold (0.6 from
	// confidence-gate.ts) so a capped run does not pass the gate. 0.59 keeps
	// the cap visually close to the threshold without bleeding the HITL value.
	const TOOL_ERROR_CONFIDENCE_CAP = 0.59;
	const degradedSubAgents = results
		.map((r) => {
			// SIO-1087: only count DEGRADING tool errors toward the rate. A routine discovery
			// outcome -- a collection with no index (no-data) or a resource that does not exist
			// (not-found) -- is a finding, not a malfunction, and must not drag confidence below
			// the HITL gate. isDegradingCategory excludes those; a toolError with no category
			// (regex-fallback path) still counts, preserving prior behaviour.
			const errorCount = (r.toolErrors ?? []).filter((e) => isDegradingCategory(e.category)).length;
			const messageCount = r.messageCount ?? 0;
			if (messageCount === 0 || errorCount === 0) return null;
			const rate = errorCount / messageCount;
			if (rate <= TOOL_ERROR_RATE_THRESHOLD) return null;
			return {
				dataSourceId: r.dataSourceId,
				deploymentId: r.deploymentId,
				toolErrorCount: errorCount,
				messageCount,
				rate: Number(rate.toFixed(3)),
			};
		})
		.filter((d): d is NonNullable<typeof d> => d !== null);

	// SIO-709 AC #2: Gaps section with >= 2 bullets triggers the same 0.59 cap.
	const GAPS_BULLET_THRESHOLD = 2;
	const gapsBulletCount = extractGapsBulletCount(answer);
	const gapsCapTriggered = gapsBulletCount >= GAPS_BULLET_THRESHOLD;

	// SIO-1013: a Gaps bullet claiming a permission/IAM denial with NO observed auth tool
	// error is fabricated. Cap confidence below the HITL gate so a hallucinated blocker
	// can never print a passing score, and rewrite the bullet to honest "not retrieved" text.
	const { ungrounded } = detectUngroundedBlockers(answer, results);
	const ungroundedCapTriggered = ungrounded.length > 0;

	// SIO-1079: a Gaps bullet claiming "logs expired / retention exceeded" with NO observed
	// absence (only a query-window MalformedQueryException) is fabricated. Cap + rewrite like
	// the IAM blocker above.
	const { ungrounded: ungroundedExpiry } = detectUngroundedExpiry(answer, results);
	const expiryCapTriggered = ungroundedExpiry.length > 0;

	// SIO-1085: (A) an absence claim contradicted by the sub-agent's own returned data
	// (elastic "not present" after fetching hits), and (B) a sweeping "all records / whole
	// pipeline" absence claim that a partial query can't support (couchbase generalizing
	// from one of several seasonal collections). Rewrite to honest scoped text + cap.
	const { contradicted, overgeneralized } = detectPrematureAbsence(answer, results);
	const prematureAbsenceCapTriggered = contradicted.length > 0 || overgeneralized.length > 0;

	// SIO-1087 (Fix D): a Root Cause line asserting a specific mechanism (schema mismatch, field
	// names absent, metadata corruption, epoch-0) that no returned data supports. Cap + soften.
	const { ungrounded: ungroundedRootCause } = detectUngroundedRootCause(answer, results);
	const ungroundedRootCauseCapTriggered = ungroundedRootCause.length > 0;

	const anyCapTriggered =
		degradedSubAgents.length > 0 ||
		gapsCapTriggered ||
		ungroundedCapTriggered ||
		expiryCapTriggered ||
		prematureAbsenceCapTriggered ||
		ungroundedRootCauseCapTriggered;
	const cappedScore = anyCapTriggered ? Math.min(confidenceScore, TOOL_ERROR_CONFIDENCE_CAP) : confidenceScore;

	if (degradedSubAgents.length > 0) {
		logger.warn(
			{
				degradedSubAgents,
				threshold: TOOL_ERROR_RATE_THRESHOLD,
				cap: TOOL_ERROR_CONFIDENCE_CAP,
				originalScore: confidenceScore,
				cappedScore,
			},
			"Sub-agent tool-error rate exceeded threshold; capping confidence",
		);
	}

	if (gapsCapTriggered) {
		logger.warn(
			{
				gapsBulletCount,
				threshold: GAPS_BULLET_THRESHOLD,
				cap: TOOL_ERROR_CONFIDENCE_CAP,
				originalScore: confidenceScore,
				cappedScore,
			},
			"Aggregator Gaps section listed missing-data items; capping confidence",
		);
	}

	if (ungroundedCapTriggered) {
		logger.warn(
			{ ungrounded, cap: TOOL_ERROR_CONFIDENCE_CAP, originalScore: confidenceScore, cappedScore },
			"Aggregator Gaps section claimed a permission blocker with no observed auth tool error; capping confidence",
		);
	}

	if (expiryCapTriggered) {
		logger.warn(
			{ ungroundedExpiry, cap: TOOL_ERROR_CONFIDENCE_CAP, originalScore: confidenceScore, cappedScore },
			"Aggregator Gaps section claimed logs expired/retention exceeded with no observed absence; capping confidence",
		);
	}

	if (prematureAbsenceCapTriggered) {
		logger.warn(
			{
				contradicted: contradicted.length,
				overgeneralized: overgeneralized.length,
				cap: TOOL_ERROR_CONFIDENCE_CAP,
				originalScore: confidenceScore,
				cappedScore,
			},
			"Aggregator asserted absence contradicted by returned data, or over-generalized 'all records' absence; rewriting + capping confidence",
		);
	}

	if (ungroundedRootCauseCapTriggered) {
		logger.warn(
			{
				ungroundedRootCause: ungroundedRootCause.length,
				cap: TOOL_ERROR_CONFIDENCE_CAP,
				originalScore: confidenceScore,
				cappedScore,
			},
			"Aggregator asserted a specific root-cause mechanism no returned data supports; softening + capping confidence",
		);
	}

	// SIO-860: when a cap triggered, rewrite the printed confidence to the capped value.
	// SIO-1013: also rewrite any ungrounded permission-blocker bullets to honest text first.
	// SIO-1079: and rewrite any ungrounded "logs expired" bullets. Chain both rewrites.
	const groundedBlockers = ungroundedCapTriggered ? rewriteUngroundedBlockers(answer, ungrounded) : answer;
	const rewrittenForExpiry = expiryCapTriggered
		? rewriteUngroundedExpiry(groundedBlockers, ungroundedExpiry)
		: groundedBlockers;
	// SIO-1085: chain the premature-absence rewrite after the expiry/blocker rewrites.
	const rewrittenForGrounding = prematureAbsenceCapTriggered
		? rewritePrematureAbsence(rewrittenForExpiry, contradicted, overgeneralized)
		: rewrittenForExpiry;
	// SIO-1087 (Fix D): chain the ungrounded-root-cause softening after the absence rewrites.
	const rewrittenForRootCause = ungroundedRootCauseCapTriggered
		? rewriteUngroundedRootCause(rewrittenForGrounding, ungroundedRootCause)
		: rewrittenForGrounding;
	const finalAnswer = anyCapTriggered
		? rewriteConfidenceInAnswer(rewrittenForRootCause, cappedScore)
		: rewrittenForRootCause;

	logger.info(
		{ duration: Date.now() - startTime, answerLength: finalAnswer.length, confidenceScore: cappedScore },
		"Aggregation complete",
	);
	return {
		messages: [new AIMessage({ content: finalAnswer })],
		finalAnswer,
		confidenceScore: cappedScore,
		skillsApplied,
		...(anyCapTriggered && { confidenceCap: TOOL_ERROR_CONFIDENCE_CAP }),
	};
}

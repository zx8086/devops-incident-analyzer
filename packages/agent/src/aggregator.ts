// agent/src/aggregator.ts
import { getLogger } from "@devops-agent/observability";
import { type DataSourceResult, isDegradingCategory, redactPiiContent } from "@devops-agent/shared";
import type { BaseMessage } from "@langchain/core/messages";
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import type { RunnableConfig } from "@langchain/core/runnables";
import { summarizeFirstAttempts } from "./alignment.ts";
import { extractIamActions } from "./aws-policy-actions.ts";
import { isGapsJudgeEnabled, judgeDegradingGapBullets } from "./gaps-judge.ts";
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

	// SIO-1149: the localcore run authored "not present in eu-shared-services-prd; deployment
	// location within that estate is unconfirmed" as a Gaps bullet -- but the service was found
	// and fully analyzed in eu-oit-prd. Cross-estate absence is a definitive scoping FINDING;
	// listing it under Gaps inflated the degrading-gap count toward the confidence cap.
	const crossEstateAbsenceRule =
		assessedEstates.length > 1
			? `\n\nCROSS-ESTATE ABSENCE IS A FINDING: If the focus service was found and analyzed in one assessed estate but is absent from another assessed estate, report the absence under that estate's findings as "not deployed in this estate" -- a definitive negative result. NEVER list cross-estate absence under "## Gaps", and never phrase it as "deployment location unconfirmed": the location IS confirmed (the estate where the service was found).`
			: "";

	// SIO-1149: Gaps bullets must be classifiable by the deterministic degrading-gap parser
	// (isDegradingGapBullet). Restating the incident's own error vocabulary or omitting a
	// recovery clause makes an accurate report read as a coverage failure. The literal
	// "recovered via" phrase is load-bearing: it must match GAP_RECOVERY_RE.
	const gapsAuthoringRule = `\n\nGAPS AUTHORING DISCIPLINE: Each "## Gaps" bullet describes MISSING DATA in neutral language. Do NOT restate the incident's own error vocabulary inside a Gaps bullet (write "ERROR-level log entries for the window were not found", not "the service logged errors"; identify a request by thread or id, not as "(failed)"). If a tool failed but its data was obtained via an alternate path (a fallback tool or a different datasource), the SAME bullet must say so explicitly using the phrase "recovered via <tool or datasource>" -- and if the data was fully recovered, report it under findings instead of Gaps. Reserve failure words (failed, error, timed out, denied) in Gaps for the investigation tool or query that malfunctioned, named explicitly.`;

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

	// SIO-1140: multi-source synthesis paraphrased the Index Advisor's server-computed
	// CREATE INDEX statements into a prose key list (couchbase-only reports kept them
	// verbatim). The DDL is the one copy-paste artifact of the EXPLAIN/ADVISOR chain and
	// hand-reconstruction is error-prone (GSI has no INCLUDE clause; key order matters).
	// Injected only when the findings actually carry DDL so other turns pay no prompt tax.
	const verbatimDdlRule = /CREATE\s+INDEX/i.test(resultsBlock)
		? `\n\nVERBATIM DDL REQUIREMENT: The datasource findings below contain one or more CREATE INDEX statements (server-computed Index Advisor output). Reproduce EVERY such statement VERBATIM inside a fenced sql code block in your recommendations -- copy the exact text; do not reword it, reorder keys, or compress an index definition into a prose key list. Prose may explain the DDL, never replace it.`
		: "";

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
			`Aggregate these datasource findings into a unified incident report. Only reference data present below -- do not fabricate metrics or timestamps.${scopeNote}${unavailableNote}${timelineGuidance}${connectivityGuidance}${perDeploymentGuidance}${awsEstateScopeGuidance}${crossEstateAbsenceRule}${gapsAuthoringRule}${confidenceFormatRule}${defensiveProseRule}${groundedBlockerRule}${healthCheckGapRule}${numericGroundingRule}${causalGroundingRule}${verbatimDdlRule}\n\nReport generation timestamp: ${new Date().toISOString()}. Use this exact value as the "Generated" date in the report header. Do not invent a different timestamp.\n\nIf no specific timestamps are available from the datasource findings (i.e., all observations are current-state snapshots rather than timestamped events), use "Current State Assessment" as the section heading instead of "Correlated Timeline", and use "Current" in the time column instead of fabricating timestamps.\n\n${resultsBlock}\n\nProvide: summary, ${hasEventSources ? "correlated timeline (markdown table), " : ""}findings per datasource${elasticDeployments.length > 1 ? " (with per-deployment sub-sections for elastic)" : ""}, confidence score (0.0-1.0), and any gaps.${continuationGuidance}`,
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

// SIO-1133: stamp the turn's requestId into the report footer DETERMINISTICALLY (never via
// a prompt instruction -- LLM-stamped values drift, see the Generated-timestamp lesson).
// The requestId IS the KG Incident node id, so a report pasted by hand into a Jira ticket
// carries a machine-readable key the learn-from lane scans for an exact match. Idempotent:
// a re-render (e.g. a resumed turn) must not append a second footer.
const REQUEST_ID_FOOTER_LABEL = "**Request-Id:**";
export function appendRequestIdFooter(answer: string, requestId: string): string {
	if (!requestId) return answer;
	const trimmed = answer.replace(/\s+$/, "");
	const footer = `${REQUEST_ID_FOOTER_LABEL} ${requestId}`;
	// Idempotent on the FOOTER specifically (CodeRabbit PR #405): match the trimmed LAST
	// line, not any occurrence -- a report that merely mentions the id in its body must not
	// suppress the required bottom footer.
	const lastLine = trimmed.slice(trimmed.lastIndexOf("\n") + 1);
	if (lastLine === footer) return answer;
	return `${trimmed}\n\n${footer}`;
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

// SIO-1106: a gap bullet DEGRADES confidence only when it reports a MALFUNCTION -- a tool/query
// that failed, erred, timed out, was blocked by auth, was unreachable, or a result that "could
// not be run/confirmed/completed". A plain routine absence ("no X found", "not applicable",
// "not queried this turn") is a normal discovery outcome, not a coverage failure, and must NOT
// count. This is the text-layer analogue of isDegradingCategory (SIO-1087), which already excludes
// the no-data/not-found categories from the degraded-SUBAGENT cap. Before this, extractGapsBulletCount
// counted every bullet identically, so a strong report that honestly enumerated one routine gap per
// datasource across a 6-7 source fan-out always tripped the >=2 cap and was pinned to 0.59 -- below
// the 0.6 HITL gate -- regardless of root-cause evidence strength (SIO-1106).
//
// Note "not available" (a tool/capability is missing -- "ksql not available in tool environment")
// is degrading, while "not applicable" (the datasource does not apply to this service) is routine;
// the regex distinguishes them by the exact word. Explicit authorization blocks ("blocked by IAM
// policy", "authentication was blocked") are degrading too -- an auth block prevents observation
// just as "access denied" / "not permitted" already do.
//
// SIO-1149 (extends SIO-1106): the single DEGRADED_GAP_RE counted the incident's own
// narrative vocabulary as tool failures -- "no ERROR-level entries", "executor-thread-716
// (failed)", "this failure pattern" all matched -- and a recovered tool timeout ("timed
// out; DLQ analysis was completed via direct topic inspection") still capped. Split into
// STRONG arms (unambiguous tool/query malfunction or access-block phrasing, standalone)
// and WEAK arms (fail*/error*/exception, counted only alongside tool/query context), and
// exempt bullets whose data was recovered via an alternate path. `parse fail` is widened
// to parse fail(?:ed|ure|ures|s)? -- the old arm's trailing \b never matched "parse
// failures", which only survived via the (now-gated) weak arm.
const DEGRADED_GAP_STRONG_RE =
	/\b(timed? ?out|timeout|unreachable|inaccessible|connection (?:refused|reset|error)|parse fail(?:ed|ure|ures|s)?|not available|unavailable|access denied|accessdenied|forbidden|unauthorized|not authorized|not permitted|permission denied|blocked by (?:auth(?:entication)?|iam|permission)|(?:auth(?:entication)?|iam|permission)\s+(?:policy\s+)?(?:was\s+)?block(?:ed|ing)|could ?n[o']t (?:be )?(?:re-?run|run|confirmed|refuted|verified|completed?|retrieved|reached|parsed|loaded)|cannot be (?:confirmed|refuted|verified|reached))\b/i;
const DEGRADED_GAP_WEAK_RE = /\b(fail(?:ed|ure|ures|s)?|errored?|errors?|exception)\b/i;
// SIO-1149: tool/query context that licenses the weak arms. GAP_TOOL_NAME_RE is
// intentionally case-SENSITIVE (no /i): lowercase snake_case is a tool name
// (kafka_list_dlq_topics); SCREAMING_SNAKE is data (a topic like DLQ_T_..., an env
// var) and must NOT make "113k messages failed into DLQ_T_..." count. Do not merge
// the two regexes into one /i regex for the same reason.
const GAP_TOOL_NAME_RE = /\b[a-z][a-z0-9]*_[a-z0-9_]+\b/;
const GAP_TOOL_WORDS_RE = /\b(?:tool|quer(?:y|ies)|api call|mcp|invocations?|lookups?|sub-?agents?)\b/i;
// SIO-1149: a failed tool whose DATA was obtained anyway (fallback tool / alternate
// datasource) is not a coverage failure. The gapsAuthoringRule prompt instructs the
// model to write the literal "recovered via <x>" clause; the broader verb set catches
// natural phrasings. Lookbehinds block negations ("could not be completed via").
const GAP_RECOVERY_RE =
	/(?<!\bnot )(?<!\bnot be )\b(?:recovered|completed|obtained|retrieved|achieved|covered|answered|succeeded)\s+(?:via|using|through|from)\b|\bfell back to\b|\bfallback (?:to|succeeded)\b/i;

export function isDegradingGapBullet(line: string): boolean {
	const hasToolContext = GAP_TOOL_NAME_RE.test(line) || GAP_TOOL_WORDS_RE.test(line);
	const degraded = DEGRADED_GAP_STRONG_RE.test(line) || (DEGRADED_GAP_WEAK_RE.test(line) && hasToolContext);
	return degraded && !GAP_RECOVERY_RE.test(line);
}

// Collect the DEGRADING gap bullets under a "Gaps" heading (see isDegradingGapBullet).
// Structure mirrors extractGapsBulletCount exactly (same heading/bullet parsing, same
// sub-bullet exclusion); only degrading bullets are kept. Returns the bullet texts so
// the SIO-1149 veto judge can re-examine exactly what the regex flagged.
// extractGapsBulletCount is kept unchanged for the observability log line so operators
// still see the total-vs-degrading split.
export function collectDegradingGapBullets(answer: string): string[] {
	const lines = answer.split("\n");
	let inGapsSection = false;
	const flagged: string[] = [];
	for (const line of lines) {
		if (inGapsSection && ANY_HEADING_RE.test(line)) break;
		if (!inGapsSection && GAPS_HEADING_RE.test(line)) {
			inGapsSection = true;
			continue;
		}
		if (inGapsSection && TOP_LEVEL_BULLET_RE.test(line) && isDegradingGapBullet(line)) {
			flagged.push(line);
		}
	}
	return flagged;
}

export function countDegradingGapBullets(answer: string): number {
	return collectDegradingGapBullets(answer).length;
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

// SIO-1120: collect the IAM actions actually observed as denied this turn. The agent-side
// ToolError has no structured `action` field (only category/kind/message), so the denied action
// is recovered from the message text of every `category:"auth"` error -- which carries either the
// MCP advice ('...include "ec2:DescribeX"') or the raw AWS message ('not authorized to perform:
// ec2:DescribeX'). Both contain the `service:Action` token that extractIamActions pulls out.
function collectObservedDeniedActions(results: DataSourceResult[]): Set<string> {
	const denied = new Set<string>();
	for (const r of results) {
		for (const e of r.toolErrors ?? []) {
			if (e.category !== "auth") continue;
			for (const action of extractIamActions(e.message)) denied.add(action);
		}
	}
	return denied;
}

// SIO-1054: scan both "## Gaps" and "## Recommendations" for ungrounded permission-denial
// bullets. A section runs from its heading until the next heading of the same-or-shallower
// level (so ### Investigate/Monitor/Escalate sub-headings inside Recommendations stay in scope).
//
// SIO-1120: grounding is now PER-ACTION, not all-or-nothing. The old guard short-circuited the
// WHOLE report the moment ANY auth error existed anywhere in the run -- so on the 2026-07-15
// localcore incident, one real auth error let a fabricated "ec2:DescribeRouteTables not permitted"
// bullet (a GRANTED action, never actually denied) sail through un-rewritten. Now a bullet is:
//   - GROUNDED (kept) only if it names an action that was actually observed as denied this turn;
//   - UNGROUNDED (flagged) if it names an action that is granted by the committed policy, OR names
//     an action that was NOT observed-denied;
//   - a bullet naming NO specific action falls back to the run-level rule (grounded iff any auth
//     error was observed) -- we can't per-action-check a claim with no action to check.
export function detectUngroundedBlockers(answer: string, results: DataSourceResult[]): { ungrounded: string[] } {
	const authErrorObserved = results.some((r) => (r.toolErrors ?? []).some((e) => e.category === "auth"));
	const observedDenied = collectObservedDeniedActions(results);

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
		const isBlockerBullet =
			sectionLevel !== null &&
			TOP_LEVEL_BULLET_RE.test(line) &&
			(PERMISSION_DENIAL_RE.test(line) || IAM_PRESCRIPTION_RE.test(line));
		if (!isBlockerBullet) continue;

		const namedActions = extractIamActions(line);
		if (namedActions.length === 0) {
			// No specific action named: fall back to the run-level rule -- grounded iff any auth
			// error was observed at all (a bare "IAM gap persists" with a real denial is plausible).
			if (!authErrorObserved) ungrounded.push(line);
			continue;
		}
		// The bullet names one or more actions. It is grounded only if EVERY named action was
		// actually observed as denied this turn. An action that was NOT observed-denied is
		// fabricated regardless of whether the policy grants it: if it's granted-but-not-observed
		// (the localcore ec2:DescribeRouteTables case) the claim is false; if it's neither granted
		// nor observed, we still have no evidence to call it "not permitted". A granted action CAN
		// be legitimately reported denied -- but only when observedDenied proves the deployed role
		// actually rejected it (e.g. an estate lagging the committed policy). Observation wins.
		const everyActionGrounded = namedActions.every((a) => observedDenied.has(a));
		if (!everyActionGrounded) ungrounded.push(line);
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
	/\b(schema mismatch|field names? (?:do not|don't|does not|doesn't) exist|wrong field names?|metadata corruption|epoch[- ]?0|corrupt(?:ed)? metadata|schema (?:drift|change))\b/i;

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

// SIO-1088: a couchbase `SELECT *` that fails with "no index available" (structured kind
// "no-index" / N1QL code 4000) means ONLY that the collection has no PRIMARY index. It is NOT
// evidence that the collection is empty, that data is missing, or that the schema/field names are
// wrong -- the data is queryable via a WHERE clause on a secondary index key. Validated live: the
// seasons.dates collection returned 878+ rows and the AFS-by-FMS lookup works. When the ONLY
// couchbase signal was a no-index failure (no returned rows), a report line claiming absence /
// schema problem for couchbase is UNGROUNDED. Grounded in the STRUCTURED toolError kind, not text.
const NO_DATA_OR_SCHEMA_CLAIM_RE =
	/\b(no (?:data|records?|documents?|rows?)\b|empty (?:collection|scope|result)|does not exist|is empty|schema mismatch|field names? (?:do not|don't|does not|doesn't) exist|wrong field names?|missing fields?|data gap|no .{0,30}season data)\b/i;

// A datasource keyword regex just for couchbase, reused from DATASOURCE_KEYWORDS.
function couchbaseHadOnlyNoIndex(results: DataSourceResult[]): boolean {
	const cb = results.filter((r) => r.dataSourceId === "couchbase");
	if (cb.length === 0) return false;
	// At least one no-index error observed...
	const anyNoIndex = cb.some((r) => (r.toolErrors ?? []).some((e) => e.kind === "no-index"));
	if (!anyNoIndex) return false;
	// ...and couchbase did NOT actually return contradicting data this turn (if it did, an absence
	// claim is separately handled by detectPrematureAbsence and we don't want to double-soften).
	return !cb.some((r) => dataSourceReturnedData(r));
}

export function detectNoIndexMisread(answer: string, results: DataSourceResult[]): { flagged: string[] } {
	if (!couchbaseHadOnlyNoIndex(results)) return { flagged: [] };
	const couchbaseKw = DATASOURCE_KEYWORDS.couchbase;
	if (!couchbaseKw) return { flagged: [] };
	const flagged: string[] = [];
	for (const line of answer.split("\n")) {
		if (headingLevel(line) !== null) continue;
		// Only flag lines that both make an absence/schema claim AND mention couchbase context, so we
		// don't touch unrelated datasources' lines.
		if (NO_DATA_OR_SCHEMA_CLAIM_RE.test(line) && couchbaseKw.test(line)) {
			flagged.push(line);
		}
	}
	return { flagged };
}

const NO_INDEX_MISREAD_SUFFIX =
	" [CORRECTION: this is grounded only in a `SELECT *` failing with 'no index available', which means the collection has no PRIMARY index -- NOT that data is missing or the schema is wrong. The collection is queryable via a WHERE clause on a secondary index key; retrieve rows that way before concluding absence.]";

export function rewriteNoIndexMisread(answer: string, flagged: string[]): string {
	if (flagged.length === 0) return answer;
	const set = new Set(flagged);
	return answer
		.split("\n")
		.map((line) => (set.has(line) ? line + NO_INDEX_MISREAD_SUFFIX : line))
		.join("\n");
}

// SIO-1140: the Index Advisor's CREATE INDEX DDL (SIO-1137 chain) is the report's one
// copy-paste artifact, and multi-source synthesis compressed it into a prose key list.
// The verbatimDdlRule prompt instruction is the primary fix; this deterministic backstop
// guarantees the statements survive. A statement is real DDL only when it has the full
// `CREATE INDEX <name> ON <keyspace>(<keys>)` shape with a key-list-looking paren group
// -- prose mentioning "CREATE INDEX" never matches. A trailing semicolon is consumed so
// terminated statements are reproduced verbatim.
const CREATE_INDEX_RE = /CREATE\s+INDEX[\s\S]*?(?:;|(?=```|\n\s*\n|$))/gi;
const CREATE_INDEX_SHAPE_RE = /^CREATE\s+INDEX\s+(?:`[^`]+`|[A-Za-z_][\w#-]*)\s+ON\s+[^(]*\(([^)]*)\)/i;
const MAX_VERBATIM_DDL_STATEMENTS = 10;

// Trailing-semicolon-insensitive so `...(a);` in prose matches `...(a)` in the answer.
function normalizeDdl(s: string): string {
	return s.replace(/\s+/g, " ").replace(/;\s*$/, "").trim();
}

// A paren group counts as a key list when it is backticked/dotted/comma-separated
// (advisor output always is) or a single bare identifier. Multi-word English like
// "(not production)" is rejected so prose mimicking DDL is never emitted as SQL.
function looksLikeKeyList(inner: string): boolean {
	const t = inner.trim();
	if (t.length === 0) return false;
	if (/[`,.[\]]/.test(t)) return true;
	return /^[\w#-]+$/.test(t);
}

// SIO-1149 (extends SIO-1140): the prose scan below cannot tell an Index Advisor
// RECOMMENDATION from an existing-index inventory quoted in the same report -- the
// localcore run "rescued" the existing ARTICLE_variantNo DDL and presented it as an
// advisor recommendation. Authoritative advisor DDL lives in the
// capella_get_index_advisor_recommendations toolOutput: markdown with deterministic
// headings (formatAdvisorResult in mcp-server-couchbase). Only the Recommended
// sections are recommendations; "## Current Indexes Used" is inventory and
// "## Raw Advisor Output" duplicates both as JSON.
const ADVISOR_TOOL_NAMES = new Set(["capella_get_index_advisor_recommendations"]);
const ADVISOR_KEEP_SECTION_RE = /^recommended (?:covering )?indexes$/i;

export function advisorRecommendedSections(results: DataSourceResult[]): string[] {
	const out: string[] = [];
	for (const r of results) {
		for (const o of r.toolOutputs ?? []) {
			if (!ADVISOR_TOOL_NAMES.has(o.toolName) || typeof o.rawJson !== "string") continue;
			let keep = false;
			const kept: string[] = [];
			for (const line of o.rawJson.split("\n")) {
				const heading = line.match(/^##\s+(.+?)\s*$/);
				if (heading) keep = ADVISOR_KEEP_SECTION_RE.test(heading[1] ?? "");
				else if (keep) kept.push(line);
			}
			if (kept.length > 0) out.push(kept.join("\n"));
		}
	}
	return out;
}

// The redactor is injectable (defaulting to the production redactPiiContent) so tests
// can assert the redaction wiring deterministically -- sibling suites mock.module the
// shared package to an identity redactor, which would make a dropped call invisible.
// SIO-1149: when the advisor toolOutput is present, only its Recommended sections are
// scanned (source "advisor"); the r.data prose scan is the fallback for older
// checkpoints / truncated toolOutputs (source "prose" -- provenance unverified).
export function extractCreateIndexStatements(
	results: DataSourceResult[],
	redact: (s: string) => string = redactPiiContent,
): { statements: string[]; source: "advisor" | "prose" } {
	const advisorTexts = advisorRecommendedSections(results);
	const source: "advisor" | "prose" = advisorTexts.length > 0 ? "advisor" : "prose";
	const texts =
		source === "advisor"
			? advisorTexts
			: results.map((r) => (typeof r.data === "string" ? r.data : "")).filter((t) => t.length > 0);
	const seen = new Set<string>();
	const out: string[] = [];
	for (const text of texts) {
		for (const m of text.match(CREATE_INDEX_RE) ?? []) {
			// Redact BEFORE comparing/appending: the model answer already passed
			// redactPiiContent, so sub-agent-derived DDL must cross the same boundary.
			const stmt = redact(m.trim());
			const shape = stmt.match(CREATE_INDEX_SHAPE_RE);
			if (!shape || !looksLikeKeyList(shape[1] ?? "")) continue;
			const key = normalizeDdl(stmt);
			if (seen.has(key)) continue;
			seen.add(key);
			out.push(stmt);
			if (out.length >= MAX_VERBATIM_DDL_STATEMENTS) return { statements: out, source };
		}
	}
	return { statements: out, source };
}

// Whitespace-normalized containment: a reflowed-but-verbatim statement in the answer
// counts as present; a paraphrase (reworded/reordered) does not.
export function ensureVerbatimDdl(
	answer: string,
	results: DataSourceResult[],
): { answer: string; appended: string[]; source: "advisor" | "prose" } {
	const { statements, source } = extractCreateIndexStatements(results);
	if (statements.length === 0) return { answer, appended: [], source };
	const answerNorm = normalizeDdl(answer);
	const missing = statements.filter((s) => !answerNorm.includes(normalizeDdl(s)));
	if (missing.length === 0) return { answer, appended: [], source };
	// SIO-1149: the header only claims Index Advisor provenance when the statements came
	// from the advisor toolOutput's Recommended sections.
	const intro =
		source === "advisor"
			? "The Index Advisor returned the following statements; reproduced exactly as computed (recommendation only -- never execute without review):"
			: "The couchbase sub-agent reported the following statements (advisor tool output was not available to verify provenance; recommendation only -- never execute without review):";
	const section = `## Server-computed index DDL (verbatim)\n\n${intro}\n\n${missing.map((s) => `\`\`\`sql\n${s}\n\`\`\``).join("\n\n")}\n`;
	// SIO-632 contract: the dedicated Confidence line stays last -- insert above it.
	const lines = answer.split("\n");
	let confIdx = -1;
	for (let i = lines.length - 1; i >= 0; i--) {
		if (STRICT_CONFIDENCE_RE.test(lines[i] ?? "")) {
			confIdx = i;
			break;
		}
	}
	const rewritten =
		confIdx >= 0
			? [...lines.slice(0, confIdx), section, ...lines.slice(confIdx)].join("\n")
			: `${answer}\n\n${section}`;
	return { answer: rewritten, appended: missing, source };
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
	// SIO-1106: the trigger now counts only DEGRADING gap bullets (tool/query failures, auth
	// blocks, un-runnable/unconfirmable results) -- not routine "looked, found nothing / not
	// applicable / not queried" bullets. A strong report enumerating one routine gap per datasource
	// across a 6-7 source fan-out previously always tripped >=2 and was pinned to 0.59 below the
	// HITL gate regardless of evidence strength. gapsBulletCount (total) is retained for the log.
	// SIO-1149: hybrid classification. The regex flags candidates; when enough flag to trigger
	// the cap, a small-model judge re-examines exactly those bullets and may exempt false
	// positives. The judge only sees flagged bullets, so it can lower the count but never raise
	// it, and any judge failure keeps the regex verdict (fail-closed: the cap applies). Clean
	// runs (below threshold) never pay the judge call.
	const GAPS_BULLET_THRESHOLD = 2;
	const gapsBulletCount = extractGapsBulletCount(answer);
	const flaggedGapBullets = collectDegradingGapBullets(answer);
	const regexFlaggedGapCount = flaggedGapBullets.length;
	let degradingGapsBulletCount = regexFlaggedGapCount;
	let gapsJudgeUsed = false;
	if (regexFlaggedGapCount >= GAPS_BULLET_THRESHOLD && isGapsJudgeEnabled()) {
		gapsJudgeUsed = true;
		const verdicts = await judgeDegradingGapBullets(flaggedGapBullets, config);
		if (verdicts !== null) {
			degradingGapsBulletCount = verdicts.filter(Boolean).length;
		}
	}
	const gapsJudgeVetoedCount = regexFlaggedGapCount - degradingGapsBulletCount;
	const gapsCapTriggered = degradingGapsBulletCount >= GAPS_BULLET_THRESHOLD;
	if (gapsJudgeUsed && !gapsCapTriggered) {
		logger.info(
			{
				regexFlaggedGapCount,
				degradingGapsBulletCount,
				gapsJudgeVetoedCount,
				threshold: GAPS_BULLET_THRESHOLD,
			},
			"Gaps judge vetoed the confidence cap (regex-flagged bullets judged non-degrading)",
		);
	}

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

	// SIO-1088: a couchbase no-data / schema-problem claim grounded ONLY in a `SELECT *` no-index
	// failure (structured kind "no-index") -- the collection has no PRIMARY index but the data is
	// queryable via a secondary index. Soften + cap so the report can't narrate "no data / schema
	// mismatch / gap" from a SELECT * failure. Validated: seasons.dates has 878+ rows.
	const { flagged: noIndexMisread } = detectNoIndexMisread(answer, results);
	const noIndexMisreadCapTriggered = noIndexMisread.length > 0;

	const anyCapTriggered =
		degradedSubAgents.length > 0 ||
		gapsCapTriggered ||
		ungroundedCapTriggered ||
		expiryCapTriggered ||
		prematureAbsenceCapTriggered ||
		ungroundedRootCauseCapTriggered ||
		noIndexMisreadCapTriggered;
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
				degradingGapsBulletCount,
				regexFlaggedGapCount,
				gapsJudgeUsed,
				gapsJudgeVetoedCount,
				threshold: GAPS_BULLET_THRESHOLD,
				cap: TOOL_ERROR_CONFIDENCE_CAP,
				originalScore: confidenceScore,
				cappedScore,
			},
			"Aggregator Gaps section listed degrading (tool/query failure) items; capping confidence",
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

	if (noIndexMisreadCapTriggered) {
		logger.warn(
			{
				noIndexMisread: noIndexMisread.length,
				cap: TOOL_ERROR_CONFIDENCE_CAP,
				originalScore: confidenceScore,
				cappedScore,
			},
			"Aggregator claimed couchbase no-data/schema-problem grounded only in a SELECT * no-index failure; correcting + capping confidence",
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
	// RE-DETECT against the already-rewritten text: an earlier blocker/expiry/absence guard may
	// have appended a suffix to a flagged root-cause line, so matching the ORIGINAL line strings
	// against rewrittenForGrounding would miss it (exact-string Set lookup) -- the cap would apply
	// with no visible "[UNVERIFIED...]" annotation on that line. Detecting on the mutated text
	// keeps the match set aligned with what is actually being rewritten.
	const rewrittenForRootCause = ungroundedRootCauseCapTriggered
		? rewriteUngroundedRootCause(
				rewrittenForGrounding,
				detectUngroundedRootCause(rewrittenForGrounding, results).ungrounded,
			)
		: rewrittenForGrounding;
	// SIO-1088: chain the no-index-misread correction last, re-detecting against the mutated text.
	const rewrittenForNoIndex = noIndexMisreadCapTriggered
		? rewriteNoIndexMisread(rewrittenForRootCause, detectNoIndexMisread(rewrittenForRootCause, results).flagged)
		: rewrittenForRootCause;
	// SIO-1140: deterministic backstop -- when a sub-agent report carried Index Advisor
	// CREATE INDEX DDL that synthesis dropped or paraphrased, append it verbatim above
	// the confidence line. Content-only; never touches the confidence score.
	const ddlEnsured = ensureVerbatimDdl(rewrittenForNoIndex, results);
	if (ddlEnsured.appended.length > 0) {
		logger.warn(
			{ appendedDdlCount: ddlEnsured.appended.length, ddlSource: ddlEnsured.source },
			"Aggregated answer dropped advisor CREATE INDEX DDL; appended verbatim section",
		);
	}
	const capped = anyCapTriggered ? rewriteConfidenceInAnswer(ddlEnsured.answer, cappedScore) : ddlEnsured.answer;
	// SIO-1133: stamp the Request-Id LAST so it sits at the very bottom of the report,
	// after every content/confidence rewrite. Deterministic (not a prompt field); post
	// PII redaction (redactPiiContent ran on the raw LLM output far upstream), so the
	// UUID is never mangled. This is the machine key the learn-from lane scans for.
	const finalAnswer = appendRequestIdFooter(capped, state.requestId);

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

// agent/src/aggregator.ts
import { getLogger } from "@devops-agent/observability";
import { type DataSourceResult, redactPiiContent } from "@devops-agent/shared";
import type { BaseMessage } from "@langchain/core/messages";
import { AIMessage, HumanMessage, SystemMessage } from "@langchain/core/messages";
import type { RunnableConfig } from "@langchain/core/runnables";
import { summarizeFirstAttempts } from "./alignment.ts";
import { createLlm } from "./llm.ts";
import { extractTextFromContent } from "./message-utils.ts";
import { buildOrchestratorPrompt, getActiveSkillNames } from "./prompt-context.ts";
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

export function getAggregateResultCapBytes(env: NodeJS.ProcessEnv = process.env): number | null {
	return readCapEnv(env.AGGREGATE_RESULT_CAP_BYTES, AGGREGATE_RESULT_CAP_BYTES_DEFAULT);
}

export function getAggregateTotalCapBytes(env: NodeJS.ProcessEnv = process.env): number | null {
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
	const systemPrompt = buildOrchestratorPrompt({ runbookFilter, wikiFocus, graphContext: state.graphContext });
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

	const messages: BaseMessage[] = [new SystemMessage(systemPrompt)];

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

	// SIO-742: when a *_health_check tool returned status:"up" for a Confluent
	// component (REST Proxy, ksqlDB, Kafka Connect, Schema Registry), do NOT list
	// that component as a gap. Gaps is for missing data; a confirmed-up health
	// probe is the OPPOSITE of missing data. This stops the Gaps-cap loop where
	// healthy components fill the Gaps section and pin confidence below 0.6.
	const healthCheckGapRule = `\n\nHEALTH-CHECK GAPS RULE: If a *_health_check or ksql_cluster_status tool returned status:"up" for a component, do NOT list that component under "## Gaps". Do NOT write "REST Proxy NOT DETECTED" or "deployment status is unconfirmed" for a component whose health-check returned up. Gaps is reserved for genuinely missing data, never for components that were probed and found healthy.`;

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
			`Aggregate these datasource findings into a unified incident report. Only reference data present below -- do not fabricate metrics or timestamps.${scopeNote}${unavailableNote}${timelineGuidance}${connectivityGuidance}${perDeploymentGuidance}${awsEstateScopeGuidance}${confidenceFormatRule}${defensiveProseRule}${healthCheckGapRule}\n\nReport generation timestamp: ${new Date().toISOString()}. Use this exact value as the "Generated" date in the report header. Do not invent a different timestamp.\n\nIf no specific timestamps are available from the datasource findings (i.e., all observations are current-state snapshots rather than timestamped events), use "Current State Assessment" as the section heading instead of "Correlated Timeline", and use "Current" in the time column instead of fabricating timestamps.\n\n${resultsBlock}\n\nProvide: summary, ${hasEventSources ? "correlated timeline (markdown table), " : ""}findings per datasource${elasticDeployments.length > 1 ? " (with per-deployment sub-sections for elastic)" : ""}, confidence score (0.0-1.0), and any gaps.${continuationGuidance}`,
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

export function extractConfidenceScore(answer: string): number {
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
const PERMISSION_DENIAL_RE =
	/\b(not permitted|access denied|accessdenied|forbidden|iam permission|permission (?:gap|denied|missing)|lacks? permission)\b/i;

export function detectUngroundedBlockers(answer: string, results: DataSourceResult[]): { ungrounded: string[] } {
	const authErrorObserved = results.some((r) => (r.toolErrors ?? []).some((e) => e.category === "auth"));
	if (authErrorObserved) return { ungrounded: [] };

	const lines = answer.split("\n");
	let inGapsSection = false;
	const ungrounded: string[] = [];
	for (const line of lines) {
		if (inGapsSection && ANY_HEADING_RE.test(line)) break;
		if (!inGapsSection && GAPS_HEADING_RE.test(line)) {
			inGapsSection = true;
			continue;
		}
		if (inGapsSection && TOP_LEVEL_BULLET_RE.test(line) && PERMISSION_DENIAL_RE.test(line)) {
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
			const errorCount = r.toolErrors?.length ?? 0;
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

	const anyCapTriggered = degradedSubAgents.length > 0 || gapsCapTriggered || ungroundedCapTriggered;
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

	// SIO-860: when a cap triggered, rewrite the printed confidence to the capped value.
	// SIO-1013: also rewrite any ungrounded permission-blocker bullets to honest text first.
	const rewrittenForGrounding = ungroundedCapTriggered ? rewriteUngroundedBlockers(answer, ungrounded) : answer;
	const finalAnswer = anyCapTriggered
		? rewriteConfidenceInAnswer(rewrittenForGrounding, cappedScore)
		: rewrittenForGrounding;

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

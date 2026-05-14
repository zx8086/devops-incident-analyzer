// agent/src/aggregator.ts
import { getLogger } from "@devops-agent/observability";
import { redactPiiContent } from "@devops-agent/shared";
import type { BaseMessage } from "@langchain/core/messages";
import { AIMessage, HumanMessage, SystemMessage } from "@langchain/core/messages";
import type { RunnableConfig } from "@langchain/core/runnables";
import { summarizeFirstAttempts } from "./alignment.ts";
import { createLlm } from "./llm.ts";
import { extractTextFromContent } from "./message-utils.ts";
import { buildOrchestratorPrompt } from "./prompt-context.ts";
import type { AgentStateType } from "./state.ts";

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

function buildAggregatorMessages(state: AgentStateType, resultsBlock: string): BaseMessage[] {
	// SIO-640: Tri-state selectedRunbooks field drives the runbook filter.
	//   null      -> no filter (preserve current behavior)
	//   []        -> filter to zero runbooks (selector chose none)
	//   [names]   -> filter to just these
	const runbookFilter = state.selectedRunbooks ?? undefined;
	const systemPrompt = buildOrchestratorPrompt({ runbookFilter });
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

	messages.push(
		new HumanMessage(
			`Aggregate these datasource findings into a unified incident report. Only reference data present below -- do not fabricate metrics or timestamps.${scopeNote}${unavailableNote}${timelineGuidance}${connectivityGuidance}${perDeploymentGuidance}${confidenceFormatRule}${defensiveProseRule}${healthCheckGapRule}\n\nReport generation timestamp: ${new Date().toISOString()}. Use this exact value as the "Generated" date in the report header. Do not invent a different timestamp.\n\nIf no specific timestamps are available from the datasource findings (i.e., all observations are current-state snapshots rather than timestamped events), use "Current State Assessment" as the section heading instead of "Correlated Timeline", and use "Current" in the time column instead of fabricating timestamps.\n\n${resultsBlock}\n\nProvide: summary, ${hasEventSources ? "correlated timeline (markdown table), " : ""}findings per datasource${elasticDeployments.length > 1 ? " (with per-deployment sub-sections for elastic)" : ""}, confidence score (0.0-1.0), and any gaps.${priorAnswer ? "\n\nIMPORTANT: Focus on answering the current query. Reference prior findings where relevant but do not repeat the full prior report." : ""}`,
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

export async function aggregate(state: AgentStateType, config?: RunnableConfig): Promise<Partial<AgentStateType>> {
	const results = state.dataSourceResults;
	if (results.length === 0) {
		logger.warn("No datasource results to aggregate");
		return {
			messages: [new AIMessage({ content: "No datasource results to aggregate." })],
			finalAnswer: "No datasource results to aggregate.",
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

	const resultsBlock = results
		.map((r) => {
			const status = r.status === "success" ? "OK" : `ERROR: ${r.error ?? "unknown"}`;
			const data = r.status === "success" ? String(r.data) : "No data";
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

	const anyCapTriggered = degradedSubAgents.length > 0 || gapsCapTriggered;
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

	logger.info(
		{ duration: Date.now() - startTime, answerLength: answer.length, confidenceScore: cappedScore },
		"Aggregation complete",
	);
	return {
		messages: [new AIMessage({ content: answer })],
		finalAnswer: answer,
		confidenceScore: cappedScore,
		...(anyCapTriggered && { confidenceCap: TOOL_ERROR_CONFIDENCE_CAP }),
	};
}

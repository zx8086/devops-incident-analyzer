// agent/src/aggregator.ts
import { getLogger } from "@devops-agent/observability";
import { redactPiiContent } from "@devops-agent/shared";
import type { BaseMessage } from "@langchain/core/messages";
import { AIMessage, HumanMessage, SystemMessage } from "@langchain/core/messages";
import type { RunnableConfig } from "@langchain/core/runnables";
import { createLlm } from "./llm.ts";
import { extractTextFromContent } from "./message-utils.ts";
import { buildOrchestratorPrompt } from "./prompt-context.ts";
import type { AgentStateType } from "./state.ts";

const logger = getLogger("agent:aggregator");

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
	const STATUS_ORIENTED_SOURCES = new Set(["kafka", "couchbase", "konnect"]);
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

	messages.push(
		new HumanMessage(
			`Aggregate these datasource findings into a unified incident report. Only reference data present below -- do not fabricate metrics or timestamps.${scopeNote}${unavailableNote}${timelineGuidance}${connectivityGuidance}${perDeploymentGuidance}${confidenceFormatRule}\n\nReport generation timestamp: ${new Date().toISOString()}. Use this exact value as the "Generated" date in the report header. Do not invent a different timestamp.\n\nIf no specific timestamps are available from the datasource findings (i.e., all observations are current-state snapshots rather than timestamped events), use "Current State Assessment" as the section heading instead of "Correlated Timeline", and use "Current" in the time column instead of fabricating timestamps.\n\n${resultsBlock}\n\nProvide: summary, ${hasEventSources ? "correlated timeline (markdown table), " : ""}findings per datasource${elasticDeployments.length > 1 ? " (with per-deployment sub-sections for elastic)" : ""}, confidence score (0.0-1.0), and any gaps.${priorAnswer ? "\n\nIMPORTANT: Focus on answering the current query. Reference prior findings where relevant but do not repeat the full prior report." : ""}`,
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

	logger.info(
		{ duration: Date.now() - startTime, answerLength: answer.length, confidenceScore },
		"Aggregation complete",
	);
	return {
		messages: [new AIMessage({ content: answer })],
		finalAnswer: answer,
		confidenceScore,
	};
}

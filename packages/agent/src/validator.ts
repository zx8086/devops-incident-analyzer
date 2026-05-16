// agent/src/validator.ts
import { getLogger } from "@devops-agent/observability";
import type { AgentStateType } from "./state.ts";

const logger = getLogger("agent:validator");
const MAX_VALIDATION_RETRIES = 2;

export function validate(state: AgentStateType): Partial<AgentStateType> {
	const answer = state.finalAnswer;
	if (!answer) {
		logger.warn("No final answer to validate");
		return { validationResult: "fail", retryCount: state.retryCount + 1 };
	}

	logger.info({ answerLength: answer.length, retryCount: state.retryCount }, "Validating answer");
	const warnings: string[] = [];

	// Check for empty or too-short answers
	if (answer.length < 50) {
		logger.warn({ answerLength: answer.length }, "Answer too short, validation failed");
		return { validationResult: "fail", retryCount: state.retryCount + 1 };
	}

	// Check that datasource results are referenced
	const results = state.dataSourceResults.filter((r) => r.status === "success");
	const answerLower = answer.toLowerCase();

	for (const result of results) {
		if (!answerLower.includes(result.dataSourceId)) {
			warnings.push(`Datasource ${result.dataSourceId} was queried but not referenced in the answer`);
		}
	}

	// Build source data: sub-agent results + prior assistant messages on follow-ups.
	// The aggregator can legitimately reference values from earlier conversation turns,
	// so the validator must include those in its comparison set.
	let sourceData = results.map((r) => String(r.data)).join(" ");
	if (state.isFollowUp) {
		const priorAssistantContent = state.messages
			.filter((m) => m._getType() === "ai" && String(m.content) !== answer)
			.map((m) => String(m.content))
			.join(" ");
		sourceData = `${sourceData} ${priorAssistantContent}`;
	}

	// SIO-768: Match BOTH ISO-8601 (`T` separator) and AWS-style string formats
	// (space separator, optional GMT/UTC/numeric-offset suffix) and normalize before
	// comparison. The previous T-only regex missed AWS SDK string outputs like
	// EC2 `StateTransitionReason` ("User initiated (2025-10-18 21:13:00 GMT)"), so
	// the aggregator's correctly-normalized ISO form in the answer was flagged as
	// fabricated even though the timestamp existed in the source data.
	const timestampPattern = /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|GMT|UTC|[+-]\d{2}:?\d{2})?/g;

	// Collapse AWS/ISO/precision variants to a single canonical key so source and
	// answer matches compare equal regardless of which form each side used.
	const normalizeTimestamp = (ts: string): string =>
		ts
			.replace(" ", "T")
			.replace(/\.\d+/, "")
			.replace(/(Z|GMT|UTC|[+-]\d{2}:?\d{2})$/, "");

	const answerTimestamps = answer.match(timestampPattern) ?? [];
	const sourceTimestamps = new Set((sourceData.match(timestampPattern) ?? []).map(normalizeTimestamp));

	// The aggregator prompt injects a "Report generation timestamp" which the LLM
	// echoes in the report header. Timestamps within 5 minutes of now are legitimate.
	const nowMs = Date.now();
	const GENERATION_WINDOW_MS = 5 * 60 * 1000;
	const isNearNow = (ts: string) => {
		const normalized = normalizeTimestamp(ts);
		return Math.abs(new Date(`${normalized}Z`).getTime() - nowMs) < GENERATION_WINDOW_MS;
	};

	const fabricatedTimestamps = answerTimestamps.filter(
		(t) => !sourceTimestamps.has(normalizeTimestamp(t)) && !isNearNow(t),
	);
	if (fabricatedTimestamps.length > 0 && sourceTimestamps.size > 0) {
		warnings.push(`Potential fabricated timestamps: ${fabricatedTimestamps.join(", ")}`);
	}

	// SIO-626: Cross-reference numerical metrics with units against source data
	const metricPattern = /(\d+(?:\.\d+)?)\s*(%|ms|MB|GB|TB|vCPUs?)\b/g;
	const answerMetrics = [...answer.matchAll(metricPattern)].map((m) => m[1] as string);
	const sourceMetricSet = new Set([...sourceData.matchAll(metricPattern)].map((m) => m[1] as string));
	if (answerMetrics.length > 0 && sourceMetricSet.size > 0) {
		const ungrounded = answerMetrics.filter((v) => !sourceMetricSet.has(v));
		if (ungrounded.length > 3) {
			const sample = ungrounded.slice(0, 5).join(", ");
			warnings.push(`${ungrounded.length} metric values in answer not found in source data (sample: ${sample})`);
		}
	}

	if (warnings.length > 0) {
		logger.warn({ warnings }, "Validation passed with warnings");
		return { validationResult: "pass_with_warnings" };
	}

	logger.info("Validation passed");
	return { validationResult: "pass" };
}

export function shouldRetryValidation(state: AgentStateType): boolean {
	const shouldRetry = state.validationResult === "fail" && state.retryCount < MAX_VALIDATION_RETRIES;
	if (shouldRetry) {
		logger.info({ retryCount: state.retryCount, maxRetries: MAX_VALIDATION_RETRIES }, "Retrying validation");
	}
	return shouldRetry;
}

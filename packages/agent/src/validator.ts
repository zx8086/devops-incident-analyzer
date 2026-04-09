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

	// Check for hallucination indicators -- fabricated timestamps not in source data.
	// The aggregator prompt injects a "Report generation timestamp" which the LLM
	// echoes in the report header. Timestamps within 5 minutes of now are legitimate.
	const timestampPattern = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/g;
	const answerTimestamps = answer.match(timestampPattern) ?? [];
	const sourceTimestamps = new Set(sourceData.match(timestampPattern) ?? []);

	const nowMs = Date.now();
	const GENERATION_WINDOW_MS = 5 * 60 * 1000;
	// Append Z if missing so timestamps without timezone are parsed as UTC (matching the
	// aggregator's new Date().toISOString() output which is always UTC)
	const isNearNow = (ts: string) => {
		const utcTs = ts.endsWith("Z") || ts.includes("+") ? ts : `${ts}Z`;
		return Math.abs(new Date(utcTs).getTime() - nowMs) < GENERATION_WINDOW_MS;
	};

	const fabricatedTimestamps = answerTimestamps.filter((t) => !sourceTimestamps.has(t) && !isNearNow(t));
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

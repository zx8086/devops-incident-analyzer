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

	// Check for hallucination indicators -- fabricated timestamps not in source data
	const timestampPattern = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/g;
	const answerTimestamps = answer.match(timestampPattern) ?? [];
	const sourceData = results.map((r) => String(r.data)).join(" ");
	const sourceTimestamps = new Set(sourceData.match(timestampPattern) ?? []);

	const fabricatedTimestamps = answerTimestamps.filter((t) => !sourceTimestamps.has(t));
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

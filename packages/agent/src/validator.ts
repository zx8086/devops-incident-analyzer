// agent/src/validator.ts
import type { AgentStateType } from "./state.ts";

const MAX_VALIDATION_RETRIES = 2;

export function validate(state: AgentStateType): Partial<AgentStateType> {
	const answer = state.finalAnswer;
	if (!answer) {
		return { validationResult: "fail", retryCount: state.retryCount + 1 };
	}

	const warnings: string[] = [];

	// Check for empty or too-short answers
	if (answer.length < 50) {
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

	if (warnings.length > 0) {
		return { validationResult: "pass_with_warnings" };
	}

	return { validationResult: "pass" };
}

export function shouldRetryValidation(state: AgentStateType): boolean {
	return state.validationResult === "fail" && state.retryCount < MAX_VALIDATION_RETRIES;
}

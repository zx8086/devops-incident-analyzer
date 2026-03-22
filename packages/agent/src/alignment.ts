// agent/src/alignment.ts
import type { AgentStateType } from "./state.ts";

const MAX_ALIGNMENT_RETRIES = 2;

export function checkAlignment(state: AgentStateType): Partial<AgentStateType> & { shouldRetry: boolean } {
	const results = state.dataSourceResults;
	const targetSources = state.targetDataSources;

	// Check if all targeted datasources returned results
	const resultIds = new Set(results.map((r) => r.dataSourceId));
	const missing = targetSources.filter((id) => !resultIds.has(id));
	const errors = results.filter((r) => r.status === "error");

	if (missing.length === 0 && errors.length === 0) {
		return { shouldRetry: false };
	}

	if (state.alignmentRetries >= MAX_ALIGNMENT_RETRIES) {
		// Max retries reached, proceed with what we have
		const hints = [
			...missing.map((id) => `${id}: no response received`),
			...errors.map((r) => `${r.dataSourceId}: ${r.error}`),
		];
		return {
			shouldRetry: false,
			alignmentHints: hints,
		};
	}

	return {
		shouldRetry: true,
		alignmentRetries: state.alignmentRetries + 1,
		alignmentHints: missing.map((id) => `Retry query for ${id}`),
	};
}

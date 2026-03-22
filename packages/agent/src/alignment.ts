// agent/src/alignment.ts
import { getLogger } from "@devops-agent/observability";
import type { AgentStateType } from "./state.ts";

const logger = getLogger("agent:alignment");
const MAX_ALIGNMENT_RETRIES = 2;

export function checkAlignment(state: AgentStateType): Partial<AgentStateType> & { shouldRetry: boolean } {
	const results = state.dataSourceResults;
	const targetSources = state.targetDataSources;

	const resultIds = new Set(results.map((r) => r.dataSourceId));
	const missing = targetSources.filter((id) => !resultIds.has(id));
	const errors = results.filter((r) => r.status === "error");
	const successes = results.filter((r) => r.status === "success");

	logger.info(
		{
			targetSources,
			received: [...resultIds],
			successes: successes.length,
			errors: errors.length,
			missing,
			retryAttempt: state.alignmentRetries,
		},
		"Alignment check",
	);

	if (missing.length === 0 && errors.length === 0) {
		logger.info("All datasources aligned, proceeding to aggregation");
		return { shouldRetry: false };
	}

	if (state.alignmentRetries >= MAX_ALIGNMENT_RETRIES) {
		const hints = [
			...missing.map((id) => `${id}: no response received`),
			...errors.map((r) => `${r.dataSourceId}: ${r.error}`),
		];
		logger.warn({ hints }, "Max alignment retries reached, proceeding with partial results");
		return {
			shouldRetry: false,
			alignmentHints: hints,
		};
	}

	logger.info({ missing, retryAttempt: state.alignmentRetries + 1 }, "Retrying missing datasources");
	return {
		shouldRetry: true,
		alignmentRetries: state.alignmentRetries + 1,
		alignmentHints: missing.map((id) => `Retry query for ${id}`),
	};
}

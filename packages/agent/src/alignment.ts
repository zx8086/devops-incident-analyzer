// agent/src/alignment.ts
import { getLogger } from "@devops-agent/observability";
import type { DataSourceResult, ToolErrorCategory } from "@devops-agent/shared";
import { Send } from "@langchain/langgraph";
import type { AgentStateType } from "./state.ts";
import { classifyToolError } from "./sub-agent.ts";

const logger = getLogger("agent:alignment");
const MAX_ALIGNMENT_RETRIES = 2;
// Defense-in-depth: hard cap on total retry results regardless of counter state.
// 4 datasources x 4 retry attempts = 16 results before we stop retrying.
const MAX_TOTAL_RETRY_RESULTS = 16;

export function getDataSourceErrorCategories(results: DataSourceResult[]): Map<string, Set<ToolErrorCategory>> {
	const categories = new Map<string, Set<ToolErrorCategory>>();
	for (const result of results) {
		if (result.status !== "error" || !result.toolErrors?.length) continue;
		const set = categories.get(result.dataSourceId) ?? new Set<ToolErrorCategory>();
		for (const err of result.toolErrors) {
			set.add(err.category);
		}
		categories.set(result.dataSourceId, set);
	}
	return categories;
}

export interface FirstAttemptSummary {
	dataSourceId: string;
	firstStatus: "success" | "error";
	firstCategory?: ToolErrorCategory;
	firstDurationMs: number;
	recovered: boolean;
}

// SIO-691: derive per-datasource first-attempt outcome from accumulated results.
// The supervisor's alignment-retry path silently re-runs failed sub-agents on a fresh
// invocation; the first failure's evidence is invisible to user-facing metrics because
// the retry's success masks it in the aggregate. This helper distinguishes first attempts
// from retries via the existing `isAlignmentRetry` discriminator -- no schema change.
// For elastic deployment fan-out, prefer a failing first-attempt result over a successful
// sibling so the summary surfaces the failure that triggered retry.
export function summarizeFirstAttempts(results: DataSourceResult[]): FirstAttemptSummary[] {
	const firstByIdMap = new Map<string, DataSourceResult>();
	const hasLaterSuccess = new Map<string, boolean>();

	for (const r of results) {
		if (!r.isAlignmentRetry) {
			const existing = firstByIdMap.get(r.dataSourceId);
			if (!existing || (existing.status === "success" && r.status === "error")) {
				firstByIdMap.set(r.dataSourceId, r);
			}
		} else if (r.status === "success") {
			hasLaterSuccess.set(r.dataSourceId, true);
		}
	}

	const out: FirstAttemptSummary[] = [];
	for (const [dataSourceId, first] of firstByIdMap) {
		const summary: FirstAttemptSummary = {
			dataSourceId,
			firstStatus: first.status === "success" ? "success" : "error",
			firstDurationMs: first.duration ?? 0,
			recovered: first.status === "error" && hasLaterSuccess.get(dataSourceId) === true,
		};
		if (first.status === "error") {
			const fromTool = first.toolErrors?.[0]?.category;
			summary.firstCategory = fromTool ?? classifyToolError(first.error ?? "").category;
		}
		out.push(summary);
	}
	return out;
}

// Uses ToolError.retryable (set by classifyToolError in sub-agent.ts) as the
// single source of truth for retry decisions. A datasource is retryable if ANY
// of its tool errors are marked retryable, or if no toolErrors exist (unknown
// failure mode -- better to retry than drop).
function isDataSourceRetryable(results: DataSourceResult[], dataSourceId: string): boolean {
	let hasToolErrors = false;
	for (const result of results) {
		if (result.dataSourceId !== dataSourceId) continue;
		if (!result.toolErrors?.length) continue;
		hasToolErrors = true;
		for (const err of result.toolErrors) {
			if (err.retryable) return true;
		}
	}
	// No toolErrors means we don't know the failure mode -- default to retryable
	return !hasToolErrors;
}

function getRetryTargets(state: AgentStateType): { retryTargets: string[]; nonRetryable: string[] } {
	const results = state.dataSourceResults;
	const targetSources = state.targetDataSources;

	const resultIds = new Set(results.map((r) => r.dataSourceId));
	const missing = targetSources.filter((id) => !resultIds.has(id));
	const errors = results.filter((r) => r.status === "error");

	// Deduplicate errored datasource IDs -- results accumulate across retries
	const erroredIds = [...new Set(errors.map((r) => r.dataSourceId).filter((id) => id !== ""))];

	const retryableErrors: string[] = [];
	const nonRetryable: string[] = [];

	for (const id of erroredIds) {
		if (isDataSourceRetryable(errors, id)) {
			retryableErrors.push(id);
		} else {
			nonRetryable.push(id);
		}
	}

	return { retryTargets: [...missing, ...retryableErrors], nonRetryable };
}

// Node function: runs alignment check and updates state metadata
export function checkAlignment(state: AgentStateType): Partial<AgentStateType> {
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
		return {};
	}

	if (state.alignmentRetries >= MAX_ALIGNMENT_RETRIES) {
		const hints = [
			...missing.map((id) => `${id}: no response received`),
			...errors.map((r) => `${r.dataSourceId}: ${r.error}`),
		];
		logger.warn({ hints }, "Max alignment retries reached, proceeding with partial results");
		return { alignmentHints: hints };
	}

	const { retryTargets, nonRetryable } = getRetryTargets(state);
	for (const id of nonRetryable) {
		const cats = getDataSourceErrorCategories(errors).get(id);
		logger.warn(
			{ dataSourceId: id, categories: cats ? [...cats] : [] },
			"Skipping retry -- non-retryable errors (auth/session)",
		);
	}

	// Increment retry counter so routeAfterAlignment sees the updated value
	if (retryTargets.length > 0) {
		return { alignmentRetries: state.alignmentRetries + 1 };
	}

	return {};
}

// Conditional edge function: decides routing after alignment
// Returns Send[] for fan-out retries or "aggregate" to proceed
export function routeAfterAlignment(state: AgentStateType): Send[] | "aggregate" {
	const results = state.dataSourceResults;
	const targetSources = state.targetDataSources;

	// Defense-in-depth: hard cap on total retry results, independent of counter
	const retryResultCount = results.filter((r) => r.isAlignmentRetry).length;
	if (retryResultCount >= MAX_TOTAL_RETRY_RESULTS) {
		logger.warn({ retryResultCount, cap: MAX_TOTAL_RETRY_RESULTS }, "Hard cap on retry results reached");
		return "aggregate";
	}

	const resultIds = new Set(results.map((r) => r.dataSourceId));
	const missing = targetSources.filter((id) => !resultIds.has(id));
	const errors = results.filter((r) => r.status === "error");

	// All aligned -- proceed to aggregation
	if (missing.length === 0 && errors.length === 0) {
		return "aggregate";
	}

	// Max retries exhausted -- proceed with partial results
	if (state.alignmentRetries >= MAX_ALIGNMENT_RETRIES) {
		return "aggregate";
	}

	const { retryTargets, nonRetryable } = getRetryTargets(state);

	// No retryable targets -- proceed with what we have
	if (retryTargets.length === 0) {
		const hints = nonRetryable.map((id) => {
			const cats = getDataSourceErrorCategories(errors).get(id);
			return `${id}: non-retryable (${cats ? [...cats].join(", ") : "unknown"})`;
		});
		logger.warn({ hints }, "No retryable datasources, proceeding with partial results");
		return "aggregate";
	}

	logger.info(
		{ retryTargets, skipped: nonRetryable, retryAttempt: state.alignmentRetries },
		"Dispatching alignment retries",
	);

	// Fan out: create a Send for each datasource that needs retrying
	// alignmentRetries was already incremented by checkAlignment node
	return retryTargets.map(
		(dataSourceId) =>
			new Send("queryDataSource", {
				...state,
				currentDataSource: dataSourceId,
				dataSourceResults: [],
				alignmentHints: [`Retry query for ${dataSourceId}`],
			}),
	);
}

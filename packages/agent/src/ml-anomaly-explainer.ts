// agent/src/ml-anomaly-explainer.ts
// SIO-1215: pure per-turn ML anomaly explainer builder. Parses the turn's
// elasticsearch_ml_get_anomaly_records tool output into the shared
// MlAnomalyExplainer shape. Called from extractFindings for the state slot +
// SSE event, and from aggregator.ts for the prompt summary -- must therefore
// stay pure, cheap, and total: a malformed or absent tool output is skipped via
// safeParse, never thrown on.
import type { DataSourceResult, MlAnomalyExplainer, MlAnomalyRecord, ToolOutput } from "@devops-agent/shared";
import { MlAnomalyJobSummarySchema, MlAnomalyRecordSchema } from "@devops-agent/shared";
import { z } from "zod";

export const MAX_RECORDS = 100;

const StructuredEnvelopeSchema = z.object({
	summaries: z.array(MlAnomalyRecordSchema),
	jobsSummary: z.array(MlAnomalyJobSummarySchema).optional(),
	lookback: z.string().optional(),
	minScoreApplied: z.number().optional(),
});

function findAnomalyRecordsOutput(results: DataSourceResult[]): ToolOutput | undefined {
	for (const r of results) {
		const output = r.toolOutputs?.find((o) => o.toolName === "elasticsearch_ml_get_anomaly_records");
		if (output) return output;
	}
	return undefined;
}

// SIO-1215: overview when many jobs/records are in scope; detail when the caller
// scoped to a single entity/job and got back a small, focused result set.
function pickMode(records: MlAnomalyRecord[]): "overview" | "detail" {
	return records.length > 0 && records.length <= 3 ? "detail" : "overview";
}

export function buildMlAnomalyExplainer(results: DataSourceResult[], turn = 0): MlAnomalyExplainer | undefined {
	const output = findAnomalyRecordsOutput(results);
	if (!output) return undefined;

	const parsed = StructuredEnvelopeSchema.safeParse(output.rawJson);
	if (!parsed.success) return undefined;

	let records = parsed.data.summaries;
	let truncated = false;
	if (records.length > MAX_RECORDS) {
		records = records.slice(0, MAX_RECORDS);
		truncated = true;
	}

	return {
		builtAtTurn: turn,
		mode: pickMode(records),
		lookback: parsed.data.lookback ?? "now-24h",
		minScoreApplied: parsed.data.minScoreApplied,
		records,
		jobsSummary: parsed.data.jobsSummary ?? [],
		investigationActions: [],
		...(truncated && { truncated }),
	};
}

const MAX_PROMPT_RECORDS = 5;

export function summarizeMlAnomalyExplainerForPrompt(explainer: MlAnomalyExplainer): string {
	if (explainer.records.length === 0) {
		return "ML anomaly records: none returned at the requested parameters.";
	}
	const lines = ["ML anomaly records (top by score):"];
	for (const r of explainer.records.slice(0, MAX_PROMPT_RECORDS)) {
		const deviation = typeof r.deviationPercent === "number" ? `${r.deviationPercent.toFixed(0)}%` : "n/a";
		lines.push(`- [${r.jobId}] score=${r.recordScore} ${r.entity ?? "(no entity)"} deviation=${deviation}`);
	}
	if (explainer.jobsSummary.length > 0) {
		lines.push(`Per-job counts: ${explainer.jobsSummary.map((j) => `${j.jobId}=${j.count}`).join(", ")}`);
	}
	return lines.join("\n");
}

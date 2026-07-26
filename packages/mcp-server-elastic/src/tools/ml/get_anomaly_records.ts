// src/tools/ml/get_anomaly_records.ts

import type { Client, estypes } from "@elastic/elasticsearch";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { logger } from "../../utils/logger.js";
import type { SearchResult, ToolRegistrationFunction } from "../types.js";

export const mlGetAnomalyRecordsValidator = z.object({
	minScore: z
		.number()
		.min(0)
		.max(100)
		.optional()
		.describe(
			"Minimum record_score (0-100). OMIT to return records at any score -- do NOT default this to a critical-only threshold. An empty result at no filter is a valid, reportable answer, not a failure.",
		),
	lookback: z
		.string()
		.optional()
		.describe("Elasticsearch date-math lower bound for `timestamp` (e.g. `now-1h`, `now-7d`). Default `now-24h`."),
	entity: z
		.string()
		.optional()
		.describe(
			"A single plain field VALUE (e.g. 'checkout-service'), not a composite `field=value; field=value` expression. Matched against by_field_value, partition_field_value, over_field_value, and every influencer_field_values entry on each record. Low-cardinality values (e.g. a shared namespace) can match a very large number of records -- report the match count so the caller can tell.",
		),
	jobId: z
		.string()
		.optional()
		.describe(
			"Anomaly detection job id, comma-separated list, or wildcard expression. Omit to search across every job's results.",
		),
	limit: z
		.number()
		.int()
		.positive()
		.max(500)
		.optional()
		.describe("Max records to return, sorted by record_score descending. Default 25."),
	verbose: z
		.boolean()
		.optional()
		.describe(
			"If true, include the full raw ES hits alongside the derived summary. Default false to keep payloads compact.",
		),
});

type MlGetAnomalyRecordsParams = z.infer<typeof mlGetAnomalyRecordsValidator>;

interface AnomalyRecordSource {
	job_id: string;
	record_score: number;
	field_name?: string;
	function?: string;
	by_field_value?: string;
	partition_field_value?: string;
	over_field_value?: string;
	actual?: number[];
	typical?: number[];
	timestamp?: number;
	influencers?: Array<{ influencer_field_name: string; influencer_field_values: string[] }>;
}

function createMlGetAnomalyRecordsMcpError(
	error: Error | string,
	context: {
		type: "validation" | "execution" | "not_found" | "permission";
		details?: unknown;
	},
): McpError {
	const message = error instanceof Error ? error.message : error;
	const errorCodeMap = {
		validation: ErrorCode.InvalidParams,
		execution: ErrorCode.InternalError,
		not_found: ErrorCode.InvalidRequest,
		permission: ErrorCode.InvalidRequest,
	};
	return new McpError(errorCodeMap[context.type], `[elasticsearch_ml_get_anomaly_records] ${message}`, context.details);
}

// SIO-1215: actual/typical are single-element arrays for the common (non-multivariate) case --
// guard against divide-by-zero and the rare multi-metric shape rather than assuming index [0].
function computeDeviationPercent(actual?: number[], typical?: number[]): number | undefined {
	const a = actual?.[0];
	const t = typical?.[0];
	if (a === undefined || t === undefined || t === 0) return undefined;
	return ((a - t) / Math.abs(t)) * 100;
}

// SIO-1215: entity is the human-readable "what" for a record -- prefer the detector's own
// by/partition/over field value (the thing the job actually modeled) over an influencer, which
// may just be correlated context.
function deriveEntity(source: AnomalyRecordSource): string | undefined {
	return (
		source.by_field_value ??
		source.partition_field_value ??
		source.over_field_value ??
		source.influencers?.[0]?.influencer_field_values?.[0]
	);
}

function summarizeRecord(hit: estypes.SearchHit<AnomalyRecordSource>): Record<string, unknown> {
	const source = hit._source;
	if (!source) return {};
	return {
		jobId: source.job_id,
		recordScore: source.record_score,
		fieldName: source.field_name,
		functionName: source.function,
		entity: deriveEntity(source),
		deviationPercent: computeDeviationPercent(source.actual, source.typical),
		actual: source.actual,
		typical: source.typical,
		timestamp: source.timestamp !== undefined ? new Date(source.timestamp).toISOString() : undefined,
	};
}

function renderRecordLine(s: Record<string, unknown>): string {
	const deviation =
		typeof s.deviationPercent === "number"
			? `${s.deviationPercent > 0 ? "+" : ""}${s.deviationPercent.toFixed(0)}%`
			: "n/a";
	return `- [${s.jobId}] score=${s.recordScore} ${s.entity ?? "(no entity)"} ${s.functionName ?? ""}(${s.fieldName ?? ""}) deviation=${deviation}`;
}

function buildEntityShouldClause(entity: string): estypes.QueryDslQueryContainer {
	return {
		bool: {
			should: [
				{ term: { by_field_value: entity } },
				{ term: { partition_field_value: entity } },
				{ term: { over_field_value: entity } },
				{ term: { "influencers.influencer_field_values": entity } },
			],
			minimum_should_match: 1,
		},
	};
}

export const registerMlGetAnomalyRecordsTool: ToolRegistrationFunction = (server: McpServer, esClient: Client) => {
	const handler = async (args: MlGetAnomalyRecordsParams): Promise<SearchResult> => {
		const perfStart = performance.now();
		let params: MlGetAnomalyRecordsParams | undefined;
		try {
			params = mlGetAnomalyRecordsValidator.parse(args);
			const lookback = params.lookback ?? "now-24h";
			const limit = params.limit ?? 25;

			const filter: estypes.QueryDslQueryContainer[] = [
				{ term: { result_type: "record" } },
				{ range: { timestamp: { gte: lookback } } },
			];
			if (params.jobId) filter.push({ term: { job_id: params.jobId } });
			if (params.minScore !== undefined) filter.push({ range: { record_score: { gte: params.minScore } } });

			const must: estypes.QueryDslQueryContainer[] = params.entity ? [buildEntityShouldClause(params.entity)] : [];

			const result = await esClient.search<AnomalyRecordSource>({
				index: ".ml-anomalies-*",
				size: limit,
				track_total_hits: true,
				query: { bool: { filter, ...(must.length > 0 && { must }) } },
				sort: [{ record_score: "desc" }],
				aggs: { by_job: { terms: { field: "job_id", size: 50 } } },
			});

			const duration = performance.now() - perfStart;
			if (duration > 5000) {
				logger.warn({ duration, jobId: params.jobId, entity: params.entity }, "Slow ML op: get_anomaly_records");
			}

			const summaries = result.hits.hits.map(summarizeRecord);
			const jobBuckets = (result.aggregations?.by_job as estypes.AggregationsStringTermsAggregate | undefined)?.buckets;
			const jobsSummary = Array.isArray(jobBuckets)
				? jobBuckets.map((bucket) => ({ jobId: String(bucket.key), count: bucket.doc_count }))
				: [];

			const totalHits =
				typeof result.hits.total === "number" ? result.hits.total : (result.hits.total?.value ?? summaries.length);
			const minScoreLabel =
				params.minScore !== undefined ? `min_score=${params.minScore}` : "no score filter (any severity)";
			const headline = `**ML anomaly records (total: ${totalHits}, returned: ${summaries.length}, lookback=${lookback}, ${minScoreLabel})**`;
			const human = [
				headline,
				`Per-job counts: ${jobsSummary.map((j) => `${j.jobId}=${j.count}`).join(", ") || "none"}`,
				...summaries.map(renderRecordLine),
			].join("\n");

			const verbose = params.verbose ?? false;
			const structured = {
				count: totalHits,
				lookback,
				minScoreApplied: params.minScore,
				jobsSummary,
				summaries,
				...(verbose && { raw: result.hits.hits }),
			};

			return {
				content: [
					{ type: "text", text: human },
					{ type: "text", text: JSON.stringify(structured, null, 2) },
				],
			};
		} catch (error) {
			if (error instanceof z.ZodError) {
				throw createMlGetAnomalyRecordsMcpError(`Validation failed: ${error.issues.map((e) => e.message).join(", ")}`, {
					type: "validation",
					details: { validationErrors: error.issues, providedArgs: args },
				});
			}
			if (error instanceof Error) {
				if (error.message.includes("security_exception")) {
					throw createMlGetAnomalyRecordsMcpError("Insufficient permissions to read ML anomaly records", {
						type: "permission",
						details: { originalError: error.message },
					});
				}
				if (error.message.includes("index_not_found")) {
					throw createMlGetAnomalyRecordsMcpError("No ML anomaly results indices found (.ml-anomalies-*)", {
						type: "not_found",
						details: { originalError: error.message },
					});
				}
			}
			throw createMlGetAnomalyRecordsMcpError(error instanceof Error ? error.message : String(error), {
				type: "execution",
				details: { duration: performance.now() - perfStart, args },
			});
		}
	};

	server.registerTool(
		"elasticsearch_ml_get_anomaly_records",
		{
			title: "Get ML Anomaly Records",
			description:
				"Search anomaly-detection RECORD results across `.ml-anomalies-*` (result_type=record). READ-ONLY. Returns recordScore, jobId, fieldName, functionName, entity, deviationPercent, actual/typical values, sorted by recordScore descending, plus a jobsSummary of per-job counts in the same call. Omit `minScore` for an unfiltered severity scan -- do NOT default to a critical-only threshold. `entity` is a single plain field value (never a composite `field=value; field=value` expression) matched across by/partition/over field values and every influencer. An empty result (count: 0) is a valid answer at the requested parameters -- call this tool once per turn; do not auto-retry with a lower minScore or wider lookback without the caller's confirmation. For job/datafeed HEALTH (state, memory, staleness) use `elasticsearch_ml_get_job_stats` instead.",
			inputSchema: mlGetAnomalyRecordsValidator.shape,
		},
		handler,
	);
};

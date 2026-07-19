// src/tools/cloudwatch/metrics-insights-query.ts
import { GetMetricDataCommand, type GetMetricDataCommandOutput } from "@aws-sdk/client-cloudwatch";
import { z } from "zod";
import type { AwsConfig } from "../../config/schemas.ts";
import { getCloudWatchClient } from "../../services/client-factory.ts";
import type { WithEstate } from "../estate-schema.ts";
import { parseRelative } from "../logs/start-query.ts";
import { wrapListTool } from "../wrap.ts";

// SIO-1161: CloudWatch Metrics Insights (SQL SELECT over GetMetricData Expression). A dedicated
// flat-schema tool rather than a MetricDataQueries record on aws_cloudwatch_get_metric_data: the
// Haiku sub-agent composes `{query, period, startRelative}` reliably but not a nested query-object
// array, and a distinct tool name lets mapAwsError gate SQL-grammar advice deterministically.
// Reject a malformed relative token at the SCHEMA layer (clear per-field error) instead of
// silently substituting a default window -- a wrong-window result reads as a false incident
// conclusion. parseRelative is pure, so probing it with nowSeconds=0 is a validity check.
const RELATIVE_TOKEN_MESSAGE = 'Use "now" or "now-<n><unit>" where unit is s/m/h/d/w (e.g. "now-3h").';
const relativeToken = (describeText: string) =>
	z
		.string()
		.refine((value) => parseRelative(value, 0) !== null, { message: RELATIVE_TOKEN_MESSAGE })
		.optional()
		.describe(describeText);

export const metricsInsightsQuerySchema = z.object({
	query: z
		.string()
		.trim()
		.min(1)
		// GetMetricData caps Expression at 2,048 characters; reject before AWS does.
		.max(2_048)
		.describe(
			'Metrics Insights SQL query (ONE per call). Copy-paste template: SELECT MAX(CPUUtilization) FROM SCHEMA("AWS/EC2", InstanceId) GROUP BY InstanceId ORDER BY MAX() DESC LIMIT 10. ' +
				'Grammar: SELECT FUNC(MetricName) FROM "Namespace" | SCHEMA("Namespace", DimKey1, ...) [WHERE DimKey = \'value\' AND ...] [GROUP BY DimKey] [ORDER BY FUNC() DESC|ASC] [LIMIT n] (n <= 500; FUNC is AVG|COUNT|MAX|MIN|SUM). ' +
				"String values in SINGLE quotes; WHERE supports ONLY = != AND (no OR/LIKE/IN). Use SCHEMA(...) with dimension keys to rank resources without knowing their ids.",
		),
	period: z
		.number()
		.int()
		.min(60)
		.max(86_400)
		.optional()
		.describe("Aggregation period in seconds (default 300; minimum 60 -- Metrics Insights granularity floor)."),
	startRelative: relativeToken(
		'Window start, RELATIVE to now (default "now-3h"). Format "now" or "now-<n><unit>", unit s/m/h/d/w. Metrics Insights max lookback is 14 days ("now-14d"); older data is not queryable via SQL.',
	),
	endRelative: relativeToken('Window end, RELATIVE to now (default "now"). Same format.'),
});

export type MetricsInsightsQueryParams = WithEstate<z.infer<typeof metricsInsightsQuerySchema>>;

const DEFAULT_START = "now-3h";
const DEFAULT_START_AGE_SECONDS = 3 * 3_600;
const DEFAULT_PERIOD_SECONDS = 300;

// Resolve the [start, end] epoch-seconds window from the relative tokens. Unlike logs
// start-query's now-30d default, the default here is now-3h: Metrics Insights caps lookback at 14
// days and incident triage wants the current hot window, not history.
export function resolveInsightsWindow(
	params: Pick<MetricsInsightsQueryParams, "startRelative" | "endRelative">,
	nowSeconds: number,
): { start: number; end: number } {
	const start =
		parseRelative(params.startRelative ?? DEFAULT_START, nowSeconds) ?? nowSeconds - DEFAULT_START_AGE_SECONDS;
	const end = parseRelative(params.endRelative ?? "now", nowSeconds) ?? nowSeconds;
	return { start, end };
}

// SIO-833 pattern: scalar projection of every returned series so a byte-truncated top-N ranking
// stays complete for the model (and for a future typed-findings extractor). Values arrive
// newest-first (ScanBy TimestampDescending below), so [0] is the latest datapoint.
export function summarizeMetricsInsights(response: GetMetricDataCommandOutput) {
	return (response.MetricDataResults ?? []).map((r) => ({
		Id: r.Id,
		Label: r.Label,
		StatusCode: r.StatusCode,
		maxValue: r.Values !== undefined && r.Values.length > 0 ? Math.max(...r.Values) : undefined,
		latestValue: r.Values?.[0],
		latestTimestamp: r.Timestamps?.[0],
	}));
}

export function metricsInsightsQuery(config: AwsConfig) {
	return wrapListTool({
		name: "aws_cloudwatch_metrics_insights_query",
		listField: "MetricDataResults",
		fn: async (params: MetricsInsightsQueryParams) => {
			const nowSeconds = Math.floor(Date.now() / 1000);
			const { start, end } = resolveInsightsWindow(params, nowSeconds);
			const client = getCloudWatchClient(config, params.estate);
			return client.send(
				new GetMetricDataCommand({
					MetricDataQueries: [
						{
							Id: "q1",
							Expression: params.query,
							Period: params.period ?? DEFAULT_PERIOD_SECONDS,
							ReturnData: true,
						},
					],
					StartTime: new Date(start * 1000),
					EndTime: new Date(end * 1000),
					// Newest-first so summarize's latestValue is deterministic regardless of the API default.
					ScanBy: "TimestampDescending",
				}),
			);
		},
		summarize: summarizeMetricsInsights,
	});
}

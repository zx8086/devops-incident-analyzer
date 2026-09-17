// src/tools/cloudwatch/describe-alarms.ts
import { DescribeAlarmsCommand } from "@aws-sdk/client-cloudwatch";
import { z } from "zod";
import type { AwsConfig } from "../../config/schemas.ts";
import { getCloudWatchClient } from "../../services/client-factory.ts";
import type { WithEstate } from "../estate-schema.ts";
import { preferSdkParam, wrapListTool } from "../wrap.ts";

export const describeAlarmsSchema = z.object({
	AlarmNames: z.array(z.string()).optional().describe("List of alarm names to filter (omit to list all)"),
	AlarmNamePrefix: z.string().optional().describe("Filter alarms whose name starts with this prefix"),
	StateValue: z.string().optional().describe("Filter by alarm state: OK | ALARM | INSUFFICIENT_DATA"),
	MaxRecords: z.number().int().optional().describe("Max results per page (1-100). Alias: limit."),
	NextToken: z.string().optional().describe("Pagination token from a previous response. Alias: cursor."),
	// SIO-838: canonical pagination aliases (map to MaxRecords/NextToken below; SDK param wins).
	limit: z.number().int().optional().describe("Canonical page-size alias (-> MaxRecords)."),
	cursor: z
		.string()
		.optional()
		.describe("Canonical pagination-token alias (-> NextToken). Pass _truncated.cursor here."),
	// SIO-1774: off by default because these fields are ~60% of every alarm.
	includeNotificationConfig: z
		.boolean()
		.optional()
		.describe(
			"Also return each alarm's notification wiring and raw state data: ActionsEnabled, AlarmActions, OKActions, InsufficientDataActions, AlarmArn, StateReasonData. Ask for it only when the question is why an alarm did or did not notify; pair it with AlarmNames or AlarmNamePrefix, as it more than doubles the response.",
		),
});

export type DescribeAlarmsParams = WithEstate<z.infer<typeof describeAlarmsSchema>>;

// SIO-1774: fields that say nothing about WHY an alarm fired. Measured on the 26 ALARM-state
// alarms of eu-oit-prd (2026-09-17): the list was 39.1 KB with them and 15.7 KB without.
// StateReasonData alone was 9.3 KB -- a raw JSON blob restating StateReason -- and the three
// action lists plus the ARN another 8.4 KB of SNS topic and resource ARNs. An OMIT list, not an
// allow list, so a diagnostic field AWS adds later (or one only some alarm types carry, like
// Metrics on a metric-math alarm) is never silently dropped.
//
// Greptile, PR #813: the first cut also dropped AlarmConfigurationUpdatedTimestamp and
// StateTransitionedTimestamp. Those are small (3.5 KB of the 39 KB) and they answer a real
// question -- "did it transition before or after the config change?" -- so they stay. The
// notification wiring answers another one ("why did this alarm not page?"), so it is opt-in
// through `includeNotificationConfig` rather than gone.
const ALARM_NOISE_FIELDS = [
	"AlarmArn",
	"ActionsEnabled",
	"OKActions",
	"AlarmActions",
	"InsufficientDataActions",
	"StateReasonData",
] as const;

export function omitAlarmNoise<T extends object>(alarm: T): Omit<T, (typeof ALARM_NOISE_FIELDS)[number]> {
	const slim = { ...alarm } as Record<string, unknown>;
	for (const field of ALARM_NOISE_FIELDS) delete slim[field];
	return slim as Omit<T, (typeof ALARM_NOISE_FIELDS)[number]>;
}

export function describeAlarms(config: AwsConfig) {
	return wrapListTool({
		name: "aws_cloudwatch_describe_alarms",
		listField: "MetricAlarms",
		fn: async (params: DescribeAlarmsParams) => {
			const client = getCloudWatchClient(config, params.estate);
			const response = await client.send(
				new DescribeAlarmsCommand({
					AlarmNames: params.AlarmNames,
					AlarmNamePrefix: params.AlarmNamePrefix,
					StateValue: params.StateValue as "OK" | "ALARM" | "INSUFFICIENT_DATA" | undefined,
					MaxRecords: preferSdkParam(params.MaxRecords, params.limit),
					NextToken: preferSdkParam(params.NextToken, params.cursor),
				}),
			);
			if (params.includeNotificationConfig === true) return response;
			return { ...response, MetricAlarms: response.MetricAlarms?.map(omitAlarmNoise) };
		},
		// SIO-833: project EVERY alarm to the fields the findings extractor reads
		// (packages/agent/src/correlation/extractors/aws.ts). When the full MetricAlarms list
		// is byte-truncated, this keeps the AWSFindingsCard count complete (fixes the 28/50 gap).
		// Scalar-only projection stays a few KB even for hundreds of alarms.
		summarize: (response) =>
			(response.MetricAlarms ?? []).map((a) => ({
				AlarmName: a.AlarmName,
				StateValue: a.StateValue,
				StateReason: a.StateReason,
				MetricName: a.MetricName,
				Namespace: a.Namespace,
				StateUpdatedTimestamp: a.StateUpdatedTimestamp,
			})),
	});
}

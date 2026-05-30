// packages/agent/src/correlation/extractors/aws.ts
// SIO-785 Phase 2: AWS CloudWatch alarm findings extractor. Reads the SDK's
// PascalCase `MetricAlarms[]` envelope from aws_cloudwatch_describe_alarms and
// maps it to the camelCase typed-findings shape consumed by AWSFindingsCard.
// CompositeAlarms are intentionally out of scope for v1 (rarely triage signal).
import type { AwsCloudWatchAlarm, AwsFindings, ToolOutput } from "@devops-agent/shared";
import { z } from "zod";

const MetricAlarmSchema = z.object({
	AlarmName: z.string(),
	StateValue: z.string(),
	StateReason: z.string().optional(),
	MetricName: z.string().optional(),
	Namespace: z.string().optional(),
	StateUpdatedTimestamp: z.string().optional(),
});

const DescribeAlarmsResponseSchema = z.object({
	MetricAlarms: z.array(z.unknown()).optional(),
	// SIO-833: complete projected alarm list attached by wrapListTool when MetricAlarms was
	// byte-truncated server-side. Prefer it so findings stay complete (28/50 -> 50/50).
	_summary: z.array(z.unknown()).optional(),
});

export function extractAwsFindings(outputs: ToolOutput[]): AwsFindings {
	const alarms: AwsCloudWatchAlarm[] = [];
	for (const o of outputs) {
		if (o.toolName !== "aws_cloudwatch_describe_alarms") continue;
		const envelope = DescribeAlarmsResponseSchema.safeParse(o.rawJson);
		if (!envelope.success) continue;
		const source = envelope.data._summary ?? envelope.data.MetricAlarms ?? [];
		for (const raw of source) {
			const parsed = MetricAlarmSchema.safeParse(raw);
			if (!parsed.success) continue;
			alarms.push({
				name: parsed.data.AlarmName,
				state: parsed.data.StateValue,
				...(parsed.data.StateReason !== undefined && { reason: parsed.data.StateReason }),
				...(parsed.data.MetricName !== undefined && { metricName: parsed.data.MetricName }),
				...(parsed.data.Namespace !== undefined && { namespace: parsed.data.Namespace }),
				...(parsed.data.StateUpdatedTimestamp !== undefined && {
					stateUpdatedAt: parsed.data.StateUpdatedTimestamp,
				}),
			});
		}
	}
	return alarms.length > 0 ? { alarms } : {};
}

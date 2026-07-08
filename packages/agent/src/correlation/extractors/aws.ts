// packages/agent/src/correlation/extractors/aws.ts
// SIO-785 Phase 2: AWS CloudWatch alarm findings extractor. Reads the SDK's
// PascalCase `MetricAlarms[]` envelope from aws_cloudwatch_describe_alarms and
// maps it to the camelCase typed-findings shape consumed by AWSFindingsCard.
// CompositeAlarms are intentionally out of scope for v1 (rarely triage signal).
import type { AwsCloudWatchAlarm, AwsFindings, ToolOutput } from "@devops-agent/shared";
import { z } from "zod";
import { matchesFocus } from "../focus-match.ts";

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

// SIO-1030: focusServices scopes the alarm list to the incident. Strict drop —
// an alarm is kept only when its name/metric/namespace references a focus service
// (matchesFocus short-circuits show-all on empty focus). No high-signal
// pass-through: an off-focus ALARM-state alarm is still dropped per the product
// decision. The correlation engine reads the same alarms via getAwsFindings and
// scopes with the same matcher (rules.ts alarmReferencesFocus), so card and rule
// agree.
export function extractAwsFindings(outputs: ToolOutput[], focusServices: string[] = []): AwsFindings {
	const alarms: AwsCloudWatchAlarm[] = [];
	for (const o of outputs) {
		if (o.toolName !== "aws_cloudwatch_describe_alarms") continue;
		const envelope = DescribeAlarmsResponseSchema.safeParse(o.rawJson);
		if (!envelope.success) continue;
		const source = envelope.data._summary ?? envelope.data.MetricAlarms ?? [];
		for (const raw of source) {
			const parsed = MetricAlarmSchema.safeParse(raw);
			if (!parsed.success) continue;
			const haystack = `${parsed.data.AlarmName} ${parsed.data.MetricName ?? ""} ${parsed.data.Namespace ?? ""}`;
			if (!matchesFocus(haystack, focusServices)) continue;
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

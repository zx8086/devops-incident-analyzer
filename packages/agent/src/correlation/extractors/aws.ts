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

// SIO-1159: mirrors couchbase's SIO-1138 UNSCOPED_FALLBACK_LIMIT -- top-N when
// focus scoping drops everything, so the card is not silently blank.
const UNSCOPED_FALLBACK_LIMIT = 5;

// Fallback ordering: an off-focus ALARM is still a better triage signal than an
// off-focus OK, so surface firing alarms first.
const STATE_PRIORITY: Record<string, number> = { ALARM: 0, INSUFFICIENT_DATA: 1, OK: 2 };

// SIO-1030: focusServices scopes the alarm list to the incident. Strict drop —
// an alarm is kept only when its name/metric/namespace references a focus service
// (matchesFocus short-circuits show-all on empty focus). The correlation engine
// reads the same alarms via getAwsFindings and scopes with the same matcher
// (rules.ts alarmReferencesFocus), so card and rule agree.
// SIO-1159: when scoping drops every alarm (run 270378e0: 35 -> 0 for the
// companion-service estate), fall back to an unscoped top-N flagged
// `unscoped: true` (mirrors couchbase SIO-1138). Rule-engine consumers skip
// unscoped rows; the card renders them as estate-wide context.
export function extractAwsFindings(outputs: ToolOutput[], focusServices: string[] = []): AwsFindings {
	const scoped: AwsCloudWatchAlarm[] = [];
	const all: AwsCloudWatchAlarm[] = [];
	for (const o of outputs) {
		if (o.toolName !== "aws_cloudwatch_describe_alarms") continue;
		const envelope = DescribeAlarmsResponseSchema.safeParse(o.rawJson);
		if (!envelope.success) continue;
		const source = envelope.data._summary ?? envelope.data.MetricAlarms ?? [];
		for (const raw of source) {
			const parsed = MetricAlarmSchema.safeParse(raw);
			if (!parsed.success) continue;
			const alarm: AwsCloudWatchAlarm = {
				name: parsed.data.AlarmName,
				state: parsed.data.StateValue,
				...(parsed.data.StateReason !== undefined && { reason: parsed.data.StateReason }),
				...(parsed.data.MetricName !== undefined && { metricName: parsed.data.MetricName }),
				...(parsed.data.Namespace !== undefined && { namespace: parsed.data.Namespace }),
				...(parsed.data.StateUpdatedTimestamp !== undefined && {
					stateUpdatedAt: parsed.data.StateUpdatedTimestamp,
				}),
			};
			all.push(alarm);
			const haystack = `${parsed.data.AlarmName} ${parsed.data.MetricName ?? ""} ${parsed.data.Namespace ?? ""}`;
			if (matchesFocus(haystack, focusServices)) scoped.push(alarm);
		}
	}
	if (scoped.length > 0) return { alarms: scoped };
	if (focusServices.length === 0 || all.length === 0) return {};
	const fallback = [...all]
		.sort((a, b) => (STATE_PRIORITY[a.state] ?? 3) - (STATE_PRIORITY[b.state] ?? 3))
		.slice(0, UNSCOPED_FALLBACK_LIMIT);
	return { alarms: fallback, unscoped: true };
}

// scripts/monitor/checks/alarms.ts
import {
	DescribeAlarmHistoryCommand,
	type DescribeAlarmHistoryCommandOutput,
	DescribeAlarmsCommand,
	type DescribeAlarmsCommandOutput,
	type MetricAlarm,
} from "@aws-sdk/client-cloudwatch";
import type { Finding, Severity } from "../report.ts";
import type { MonitorState } from "../state.ts";

// Structural subset of every AWS SDK v3 client: the command decides the
// output shape, so callers narrow the result to that command's Output type.
export interface AwsClient {
	send(cmd: unknown): Promise<unknown>;
}

// SIO-1739: an alarm that fires because a metric is LOW is a capacity or idle
// signal (CPU at 19.94% against a 20% floor), not an outage; it was paging
// critical and buying a full investigation per flap. HealthyHostCount is the
// exception: too few healthy hosts IS the outage.
const LOW_SIDE_IDLE_METRIC = /Utilization$|^(RequestCount|Invocations)$/;
// Transitions INTO ALARM within the history window at or above which the alarm
// is reported as flapping and downgraded to warn.
const FLAP_TRANSITIONS = 3;
const HISTORY_WINDOW_MS = 86_400_000;

export type CheckAlarmsOpts = { now?: number; flapTransitions?: number };

function firstDatapoint(reason: string | undefined): number | null {
	// "Threshold Crossed: 1 datapoint [19.94 (14/09/26 16:40:00)] was less than ..."
	const m = /datapoints? \[(-?[\d.]+)/.exec(reason ?? "");
	return m ? Number(m[1]) : null;
}

// SIO-1754: an alarm whose every action is a scaling policy exists to drive
// Application/EC2 Auto Scaling; its ALARM state is the mechanism working, not
// an assertion that something is wrong. On 2026-09-16 every alarm in ALARM in
// eu-oit-prd (26/26) and 38 of 39 in eu-shared-services-prd were these, and
// no alarm in any prd account mixed a scaling action with a notification. An
// alarm that also notifies someone stays a finding: a person asked to be told.
export function isScalingTrigger(a: { AlarmActions?: string[] }): boolean {
	const actions = a.AlarmActions ?? [];
	return actions.length > 0 && actions.every((arn) => arn.includes(":scalingPolicy:"));
}

// Composite alarms carry the same name/state/actions fields the check reads.
export async function describeAllAlarms(client: AwsClient, input: { StateValue?: "ALARM" }): Promise<MetricAlarm[]> {
	const out: MetricAlarm[] = [];
	let nextToken: string | undefined;
	do {
		const resp = (await client.send(
			new DescribeAlarmsCommand({ ...input, NextToken: nextToken }),
		)) as DescribeAlarmsCommandOutput;
		out.push(...(resp.MetricAlarms ?? []), ...((resp.CompositeAlarms ?? []) as MetricAlarm[]));
		nextToken = resp.NextToken;
	} while (nextToken);
	return out;
}

function isLowSideIdle(a: MetricAlarm): boolean {
	return (a.ComparisonOperator ?? "").startsWith("LessThan") && LOW_SIDE_IDLE_METRIC.test(a.MetricName ?? "");
}

// Count of transitions into ALARM inside the window. cloudwatch:DescribeAlarmHistory
// is on the pi-coms-extensions policy; a denial or throttle must not take the
// whole alarm check down, so a failed read counts as no flap information.
async function alarmTransitions(client: AwsClient, name: string, now: number): Promise<number | null> {
	try {
		let count = 0;
		let nextToken: string | undefined;
		do {
			const resp = (await client.send(
				new DescribeAlarmHistoryCommand({
					AlarmName: name,
					HistoryItemType: "StateUpdate",
					StartDate: new Date(now - HISTORY_WINDOW_MS),
					EndDate: new Date(now),
					MaxRecords: 100,
					NextToken: nextToken,
				}),
			)) as DescribeAlarmHistoryCommandOutput;
			const items = resp.AlarmHistoryItems;
			if (!Array.isArray(items)) return null;
			count += items.filter((i) => /to ALARM$/.test(i.HistorySummary ?? "")).length;
			nextToken = resp.NextToken;
		} while (nextToken);
		return count;
	} catch {
		return null;
	}
}

export async function checkAlarms(
	client: AwsClient,
	state: MonitorState,
	opts: CheckAlarmsOpts = {},
): Promise<Finding[]> {
	const now = opts.now ?? Date.now();
	const flapAt = opts.flapTransitions ?? FLAP_TRANSITIONS;
	const findings: Finding[] = [];
	// SIO-1754: DescribeAlarms returns 50 per page; one page left 48 of 98
	// eu-shared-services-prd alarms (everything after the 50th by name) unread.
	const alarms: MetricAlarm[] = await describeAllAlarms(client, {});
	for (const a of alarms) {
		const name: string = a.AlarmName ?? "unknown";
		const sv: string = a.StateValue ?? "OK";
		const key = `alarm:${name}:${sv}`;
		const prefix = `alarm:${name}:`;
		if (isScalingTrigger(a)) {
			// Alerted before this rule existed: drop the key so a later recovery
			// cannot surface as a finding for an alarm that is never reported.
			state.clearAlerts(prefix);
			continue;
		}
		if (sv === "OK") {
			// Recovery is a finding only when a non-OK state was alerted before.
			const prior = state.alertKeys(prefix).filter((k) => k !== key);
			if (prior.length > 0) {
				state.clearAlerts(prefix);
				state.markAlerted(key, "alarm");
				findings.push({
					family: "alarm",
					severity: "info",
					resource: name,
					summary: `Alarm ${name} recovered to OK`,
					dedup_key: key,
					evidence: { state: sv, reason: a.StateReason ?? null },
					at: new Date(now).toISOString(),
				});
			}
			continue;
		}
		if (!state.shouldAlert(key)) continue;
		state.clearAlerts(prefix);
		state.markAlerted(key, "alarm");
		// INSUFFICIENT_DATA is info: nightly scale-to-zero flaps dozens of
		// alarms into it by design, and a warn here buys an agent
		// investigation of a metric gap. Journaled and reported, never
		// investigated.
		let severity: Severity = sv === "ALARM" ? "critical" : "info";
		const notes: string[] = [];
		let flapping: number | null = null;
		if (sv === "ALARM") {
			if (isLowSideIdle(a)) {
				severity = "warn";
				notes.push("low-side utilization alarm");
			}
			const transitions = await alarmTransitions(client, name, now);
			if (transitions !== null && transitions >= flapAt) {
				severity = "warn";
				flapping = transitions;
				notes.push(`flapping: ${transitions} transitions into ALARM in 24h`);
			}
		}
		findings.push({
			family: "alarm",
			severity,
			resource: name,
			summary: `Alarm ${name} entered ${sv}${notes.length > 0 ? ` (${notes.join("; ")})` : ""}`,
			dedup_key: key,
			// The metric, threshold and datapoint travel with the finding so the
			// spoke reasons from the alarm definition instead of re-describing it.
			evidence: {
				state: sv,
				reason: a.StateReason ?? null,
				metric: a.MetricName
					? {
							namespace: a.Namespace ?? null,
							name: a.MetricName,
							dimensions: Object.fromEntries((a.Dimensions ?? []).map((d) => [d.Name ?? "", d.Value ?? ""])),
						}
					: null,
				comparison: a.ComparisonOperator ?? null,
				threshold: a.Threshold ?? null,
				datapoint: firstDatapoint(a.StateReason),
				...(flapping !== null ? { flapping } : {}),
			},
			at: new Date(now).toISOString(),
		});
	}
	return findings;
}

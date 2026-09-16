// scripts/monitor/checks/scaling.ts
import {
	type Activity,
	DescribeScalingActivitiesCommand,
	type DescribeScalingActivitiesCommandOutput,
} from "@aws-sdk/client-auto-scaling";
import { type Finding, overflowFinding } from "../report.ts";
import type { MonitorState } from "../state.ts";
import type { AwsClient } from "./alarms.ts";

// SIO-1748: autoscaling:DescribeScalingActivities was granted and unread.
//
// This one needs no invented threshold: Auto Scaling labels the activity
// Failed or Cancelled itself, so the discriminator is the API's own
// vocabulary. A successful scale in or out is the overwhelming majority of
// activities and is never read here.
//
// A failed scaling activity is usually how capacity problems first become
// visible -- InsufficientInstanceCapacity in an AZ, a launch template that
// references a deleted AMI or security group, an IAM role the ASG can no
// longer pass -- and none of those produce an alarm unless somebody wrote one.
//
// Application Auto Scaling (ECS, DynamoDB, Lambda) is deliberately not read
// here. Its DescribeScalingActivities requires a ServiceNamespace, so it is a
// call per namespace, and its ECS failures already surface through the service
// event stream that checks/tasks.ts reads. Worth adding only if the shadow run
// shows the tasks check missing them.
// Failed only. "Cancelled" usually means a later scaling decision superseded
// this one, which is normal during a scale in/out oscillation, and deciding
// otherwise needs a correlation this check cannot do reliably: the successful
// activity that superseded it may sit outside the watermark window. Reporting
// it as a failure -- in a summary that literally says "failed" -- would be a
// false positive by construction, and the asg-scaling-failure runbook already
// says a cancelled activity has to be correlated before it means anything.
const FAILED_CODES = new Set(["Failed"]);
const FIRST_LOOKBACK_MS = 3_600_000;
const REALERT_MS = 86_400_000;
const PAGE = 100;
const MAX_FINDINGS = 10;
const SUMMARY_GROUPS = 5;

export type CheckScalingOpts = { now?: number };

// One cause takes many activities at once -- an AZ out of capacity fails every
// launch into it -- so activities sharing a normalized message collapse into
// one finding, the way checks/drift.ts collapses a node-pool replacement.
// Instance ids, request ids, timestamps and counts are what differ between
// otherwise identical failures, so they are stripped before grouping.
export function signature(message: string): string {
	return message
		.replace(/i-[0-9a-f]{8,}/g, "<instance>")
		.replace(/sir-[0-9a-z]{8,}/g, "<spot-request>")
		.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<uuid>")
		.replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z?/g, "<ts>")
		.replace(/\b\d+\b/g, "<n>")
		.trim()
		.slice(0, 300);
}

export async function checkScaling(
	client: AwsClient,
	state: MonitorState,
	opts: CheckScalingOpts = {},
): Promise<Finding[]> {
	const now = opts.now ?? Date.now();
	const at = new Date(now).toISOString();
	const since = state.getWatermark("scaling:activities") ?? now - FIRST_LOOKBACK_MS;

	const activities: Activity[] = [];
	let nextToken: string | undefined;
	let newest = since;
	// Activities come back newest first, so the walk can stop at the watermark
	// rather than paging the whole history every cycle.
	outer: do {
		const resp = (await client.send(
			new DescribeScalingActivitiesCommand({ MaxRecords: PAGE, NextToken: nextToken }),
		)) as DescribeScalingActivitiesCommandOutput;
		for (const a of resp.Activities ?? []) {
			const started = a.StartTime ? new Date(a.StartTime).getTime() : 0;
			if (started <= since) break outer;
			if (started > newest) newest = started;
			if (FAILED_CODES.has(a.StatusCode ?? "")) activities.push(a);
		}
		nextToken = resp.NextToken;
	} while (nextToken);

	const groups = new Map<string, Activity[]>();
	for (const a of activities) {
		const sig = signature(a.StatusMessage ?? a.Description ?? a.Cause ?? "unknown");
		groups.set(sig, [...(groups.get(sig) ?? []), a]);
	}

	const findings: Finding[] = [];
	// Indexed, so hitting the cap on the LAST cause is not mistaken for an
	// overflow: what matters is whether anything is left unprocessed, not
	// whether the cap was reached.
	const ordered = [...groups.entries()];
	let omitted = 0;
	for (const [i, [sig, group]] of ordered.entries()) {
		const names = [...new Set(group.map((a) => a.AutoScalingGroupName ?? "unknown"))];
		const resource = names.length === 1 ? (names[0] as string) : "asg:batch";
		const key = `scaling:${resource}:${sig.slice(0, 80)}`;
		if (!state.shouldAlert(key, REALERT_MS)) continue;
		state.markAlerted(key, "scaling");
		const shown = names.slice(0, SUMMARY_GROUPS).join(", ");
		const more = names.length > SUMMARY_GROUPS ? ` (+${names.length - SUMMARY_GROUPS} more)` : "";
		findings.push({
			family: "scaling",
			severity: "warn",
			resource,
			summary:
				names.length === 1
					? `Auto Scaling activity failed on ${shown}: ${group[0]?.StatusMessage ?? group[0]?.Cause ?? sig}`
					: `${group.length} Auto Scaling activities failed with one cause across ${names.length} groups (${shown}${more}): ${group[0]?.StatusMessage ?? sig}`,
			dedup_key: key,
			evidence: {
				count: group.length,
				autoScalingGroups: names,
				statusCode: group[0]?.StatusCode ?? null,
				statusMessage: group[0]?.StatusMessage ?? null,
				// The cause names the trigger (a target-tracking policy, a health
				// check replacement, a manual capacity change), which decides
				// whether the failure matters or the scaling was incidental.
				cause: group[0]?.Cause ?? null,
				startTime: group[0]?.StartTime ?? null,
				activities: group.slice(0, SUMMARY_GROUPS).map((a) => ({
					activityId: a.ActivityId ?? null,
					group: a.AutoScalingGroupName ?? null,
					description: a.Description ?? null,
					startTime: a.StartTime ?? null,
				})),
			},
			at,
		});
		if (findings.length >= MAX_FINDINGS) {
			// Count what is genuinely left, rather than deriving it from
			// findings.length: a cause the fingerprint already suppressed was
			// processed, not omitted, and subtracting would inflate the number.
			omitted = ordered.length - (i + 1);
			break;
		}
	}

	// An overflow that just fell off the end would be lost twice over: absent
	// from the report, and then excluded from every later scan by a watermark
	// that had advanced past it. So the omitted groups are named, and the
	// watermark is held back so they are re-collected next cycle (their
	// fingerprints stop the emitted ones repeating).
	if (omitted > 0) {
		findings.push(overflowFinding("scaling", omitted, MAX_FINDINGS, at));
	} else {
		// Bounded by the scan start, as elsewhere: an activity that starts
		// mid-scan must be seen next cycle rather than skipped.
		state.setWatermark("scaling:activities", Math.min(newest, now));
	}
	return findings;
}

// scripts/monitor/checks/stacks.ts
import {
	DescribeStackEventsCommand,
	type DescribeStackEventsCommandOutput,
	DescribeStacksCommand,
	type DescribeStacksCommandOutput,
	type Stack,
} from "@aws-sdk/client-cloudformation";
import type { Finding, Severity } from "../report.ts";
import type { MonitorState } from "../state.ts";
import type { AwsClient } from "./alarms.ts";

// SIO-1749: the cloudformation reads were granted and no check used them.
//
// CloudFormation states its own verdict in StackStatus, so this needs no
// threshold and no invented vocabulary -- the discriminator is a suffix of the
// status enum. Verified across three production accounts: 34 stacks, every one
// CREATE_COMPLETE or UPDATE_COMPLETE, so the quiet case really is quiet.
//
// Edge-triggered on a snapshot diff rather than on the status itself. A stack
// that has been sitting in UPDATE_ROLLBACK_COMPLETE for a year is not news
// every day; the transition into it was.
const FAILED_SUFFIX = /_FAILED$/;
// A create that failed and rolled back leaves an unusable stack that must be
// deleted before it can be recreated, so it is worth reporting even though the
// rollback itself succeeded.
const ROLLED_BACK = new Set(["ROLLBACK_COMPLETE", "UPDATE_ROLLBACK_COMPLETE", "IMPORT_ROLLBACK_COMPLETE"]);
const EVENT_SAMPLE = 5;
const MAX_FINDINGS = 10;

export type CheckStacksOpts = { now?: number };

export function classifyStackStatus(status: string): Severity | null {
	if (FAILED_SUFFIX.test(status)) return "critical";
	if (ROLLED_BACK.has(status)) return "warn";
	return null;
}

export async function checkStacks(
	client: AwsClient,
	state: MonitorState,
	opts: CheckStacksOpts = {},
): Promise<Finding[]> {
	const now = opts.now ?? Date.now();
	const at = new Date(now).toISOString();

	const stacks: Stack[] = [];
	let nextToken: string | undefined;
	do {
		const resp = (await client.send(
			new DescribeStacksCommand({ NextToken: nextToken }),
		)) as DescribeStacksCommandOutput;
		stacks.push(...(resp.Stacks ?? []));
		nextToken = resp.NextToken;
	} while (nextToken);

	const prev = state.getSnapshot("cfn-stacks");
	const current: Record<string, string> = {};
	for (const s of stacks) {
		if (s.StackName) current[s.StackName] = s.StackStatus ?? "unknown";
	}

	const findings: Finding[] = [];
	// First run establishes the baseline silently, the way the compliance check
	// does: a pre-existing failed stack is a known state, not today's news.
	if (prev !== null) {
		for (const s of stacks) {
			const name = s.StackName;
			const status = s.StackStatus ?? "unknown";
			if (!name) continue;
			if (prev[name] === status) continue;
			const severity = classifyStackStatus(status);
			if (severity === null) continue;

			// The failing resource is what makes this diagnosable, and it is one
			// extra call only for a stack that has actually failed.
			let failedResources: { logicalId: string | null; status: string | null; reason: string | null }[] = [];
			try {
				const ev = (await client.send(
					new DescribeStackEventsCommand({ StackName: name }),
				)) as DescribeStackEventsCommandOutput;
				failedResources = (ev.StackEvents ?? [])
					.filter((e) => FAILED_SUFFIX.test(e.ResourceStatus ?? ""))
					.slice(0, EVENT_SAMPLE)
					.map((e) => ({
						logicalId: e.LogicalResourceId ?? null,
						status: e.ResourceStatus ?? null,
						reason: e.ResourceStatusReason ?? null,
					}));
			} catch {
				// A denied or throttled event read must not lose the finding: the
				// status transition is the signal, the events are only evidence.
			}

			findings.push({
				family: "stacks",
				severity,
				resource: name,
				summary: `CloudFormation stack ${name} is ${status}${
					failedResources[0]?.reason ? `: ${failedResources[0].reason}` : ""
				}`,
				dedup_key: `stacks:${name}:${status}`,
				evidence: {
					stackName: name,
					status,
					previousStatus: prev[name] ?? null,
					statusReason: s.StackStatusReason ?? null,
					driftStatus: s.DriftInformation?.StackDriftStatus ?? null,
					lastUpdated: s.LastUpdatedTime ?? null,
					failedResources,
				},
				at,
			});
			if (findings.length >= MAX_FINDINGS) break;
		}
	}

	state.setSnapshot("cfn-stacks", current);
	return findings;
}

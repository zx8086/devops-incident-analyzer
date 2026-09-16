// scripts/monitor/checks/tasks.ts
import {
	DescribeServicesCommand,
	type DescribeServicesCommandOutput,
	ListClustersCommand,
	type ListClustersCommandOutput,
	ListServicesCommand,
	type ListServicesCommandOutput,
	type Service,
} from "@aws-sdk/client-ecs";
import type { Finding, Severity } from "../report.ts";
import type { MonitorState } from "../state.ts";
import type { AwsClient } from "./alarms.ts";

// SIO-1748: the ecs:* reads were granted and no check used them.
//
// Stopped tasks are NOT the signal. Every deployment stops tasks, every
// scale-in stops tasks, and a spot reclaim stops tasks; reporting them would
// be pure noise. All three signals here are things ECS itself asserts about a
// service, which is what makes them discriminating:
//
//  1. A deployment whose rolloutState is FAILED. The deployment circuit
//     breaker has already decided; there is no benign reading.
//  2. A service event matching a failure phrase ECS emits. These are free --
//     DescribeServices returns the last events with the service -- and they
//     name the failure in AWS's own words. "is unable to consistently start
//     tasks successfully" is ECS reporting a crash loop, which counts alone
//     cannot see: tasks that die and are replaced fast enough keep
//     runningCount at desiredCount the whole time.
//  3. runningCount below desiredCount, sustained across TWO CYCLES. A
//     deployment or a scale-out converges in minutes, so a single cycle below
//     desired is the normal shape of a deploy rather than a fault.
//
// The stopped-task reasons are deliberately left to the investigation. The
// spoke has the AWS CLI and the ecs-task-failures runbook; the monitor's job
// is to notice and hand over what it already holds, not to run the diagnosis.
const DESCRIBE_BATCH = 10;
const REALERT_MS = 86_400_000;
const MAX_FINDINGS = 10;
const EVENT_WINDOW_MS = 3_600_000;

// Event classification. Two sources, each answering a different question.
//
// WHICH FAILURE EVENTS EXIST comes from AWS's own service event message list
// (docs.aws.amazon.com/AmazonECS/latest/developerguide/service-event-messages-list.html),
// because a failure is rare by construction: a sample of mostly-healthy
// services cannot enumerate them. An earlier revision deleted the crash-loop
// pattern precisely because it was absent from a healthy corpus, which was the
// wrong inference -- absence of a failure in a healthy sample is not evidence
// the failure does not exist.
//
// WHICH EVENTS ARE ROUTINE comes from the real corpus (tests/aws-samples.ts:
// 2190 events, 22 production services). That is what a corpus is good for, and
// it is decisive: "has reached a steady state" alone occurs 1602 times.
//
// The original mistake this guards against was neither of those -- it was
// inventing the wording. "failed container health checks" is not a string ECS
// ever emits, and it was tested against a fake client that echoed it back.
const EVENT_FAILURES: { pattern: RegExp; severity: Severity; label: string }[] = [
	// The scheduler has given up retrying at normal speed. This is the crash
	// loop that counts cannot see: tasks die and are replaced fast enough that
	// runningCount never drops below desiredCount.
	{ pattern: /is unable to consistently start tasks successfully/i, severity: "critical", label: "crash loop" },
	// The circuit breaker: the deployment did not come up. Observed in the corpus.
	{
		pattern: /deployment failed: tasks failed to start/i,
		severity: "critical",
		label: "deployment failed to start tasks",
	},
	// ECS can no longer maintain the service at all.
	{
		pattern: /IAM (?:permissions policies|trust relationship) (?:have|has) been misconfigured/i,
		severity: "critical",
		label: "IAM misconfigured",
	},
	// Observed in the corpus: the circuit breaker reverting a deployment.
	{ pattern: /rolling back to deployment/i, severity: "warn", label: "deployment rolled back" },
	// Capacity. Covers the bare form and every "Reason:" variant the docs list
	// (concurrent task limit, vCPU limit, CPU/MEMORY above limit, capacity
	// unavailable, internal error).
	{ pattern: /was unable to place a task/i, severity: "warn", label: "cannot place task" },
	{
		pattern: /tasks provisioning capacity limit was exceeded/i,
		severity: "warn",
		label: "provisioning capacity limit",
	},
	// Deployment cannot converge. Observed in the corpus as a scale-in blocked
	// by task protection; the docs also list a capacity-provider variant.
	{ pattern: /was unable to reach steady state/i, severity: "warn", label: "cannot reach steady state" },
	{ pattern: /could not launch \d+ tasks? for deployment/i, severity: "warn", label: "could not launch tasks" },
	{
		pattern: /was unable to stop or start tasks during a deployment/i,
		severity: "warn",
		label: "deployment configuration blocks replacement",
	},
	{ pattern: /operations are being throttled/i, severity: "warn", label: "scheduler throttled" },
	{ pattern: /Timed out waiting for Amazon ECS Agent to start/i, severity: "warn", label: "ECS agent did not start" },
	// A misconfigured target group, which unlike an unhealthy target does not
	// heal on its own.
	{ pattern: /TARGET (?:GROUP )?IS NOT FOUND/i, severity: "warn", label: "target group missing" },
];

// Deliberately NOT classified: "(task ...) is unhealthy in (target-group ...)"
// and its "(elb ...)" variant. 27 occurrences in the corpus, every one
// self-healed -- ECS replaced the tasks and the service returned to steady
// state. checks/targets.ts owns persistent unhealthy targets behind a
// two-cycle gate; classifying them here would report a deployment as an
// incident. This exclusion is evidence-backed, which is the one thing the
// corpus can settle that the docs cannot.

export type CheckTasksOpts = { now?: number };

// Exported so the real-corpus test can exercise it directly: a check whose
// only test path is a hand-written AWS client tests the fake, not the code.
export function classifyServiceEvent(message: string): { severity: Severity; label: string } | null {
	const match = EVENT_FAILURES.find((f) => f.pattern.test(message));
	return match ? { severity: match.severity, label: match.label } : null;
}

function serviceName(s: Service): string {
	return s.serviceName ?? s.serviceArn?.split("/").pop() ?? "unknown";
}

function clusterName(arn: string): string {
	return arn.split("/").pop() ?? arn;
}

async function listAllServices(client: AwsClient, cluster: string): Promise<string[]> {
	const arns: string[] = [];
	let nextToken: string | undefined;
	do {
		const resp = (await client.send(new ListServicesCommand({ cluster, nextToken }))) as ListServicesCommandOutput;
		arns.push(...(resp.serviceArns ?? []));
		nextToken = resp.nextToken;
	} while (nextToken);
	return arns;
}

export async function checkTasks(
	client: AwsClient,
	state: MonitorState,
	opts: CheckTasksOpts = {},
): Promise<Finding[]> {
	const now = opts.now ?? Date.now();
	const at = new Date(now).toISOString();
	const findings: Finding[] = [];

	const clusters: string[] = [];
	let clusterToken: string | undefined;
	do {
		const resp = (await client.send(new ListClustersCommand({ nextToken: clusterToken }))) as ListClustersCommandOutput;
		clusters.push(...(resp.clusterArns ?? []));
		clusterToken = resp.nextToken;
	} while (clusterToken);

	const prev = state.getSnapshot("ecs-services") ?? {};
	const current: Record<string, string> = {};
	const stillFailing = new Set<string>();
	// A capped scan must not write state as though it had seen everything: the
	// services it never reached would lose their shortfall history and have
	// their fingerprints cleared, so the next cycle re-alerts and the two-cycle
	// gate restarts from zero.
	const scanned = new Set<string>();
	let truncated = false;
	const eventSince = state.getWatermark("tasks:events") ?? now - EVENT_WINDOW_MS;
	let newestEvent = eventSince;

	for (const clusterArn of clusters) {
		const cluster = clusterName(clusterArn);
		const serviceArns = await listAllServices(client, clusterArn);

		for (let i = 0; i < serviceArns.length; i += DESCRIBE_BATCH) {
			const resp = (await client.send(
				new DescribeServicesCommand({ cluster: clusterArn, services: serviceArns.slice(i, i + DESCRIBE_BATCH) }),
			)) as DescribeServicesCommandOutput;

			for (const svc of (resp.services ?? []) as Service[]) {
				const name = serviceName(svc);
				const resource = `${cluster}/${name}`;
				const desired = svc.desiredCount ?? 0;
				const running = svc.runningCount ?? 0;
				const short = desired > 0 && running < desired;
				current[resource] = short ? `short:${running}/${desired}` : "ok";
				scanned.add(resource);

				// 1. The circuit breaker has already ruled.
				const failed = (svc.deployments ?? []).filter((d) => d.rolloutState === "FAILED");
				if (failed.length > 0) {
					const key = `tasks:${resource}:rollout-failed`;
					stillFailing.add(key);
					if (state.shouldAlert(key, REALERT_MS)) {
						state.markAlerted(key, "tasks");
						findings.push({
							family: "tasks",
							severity: "critical",
							resource,
							summary: `ECS service ${resource} deployment rollout FAILED: ${failed[0]?.rolloutStateReason ?? "no reason given"}`,
							dedup_key: key,
							evidence: {
								cluster,
								service: name,
								desiredCount: desired,
								runningCount: running,
								taskDefinition: failed[0]?.taskDefinition ?? svc.taskDefinition ?? null,
								rolloutStateReason: failed[0]?.rolloutStateReason ?? null,
								deployments: (svc.deployments ?? []).map((d) => ({
									status: d.status ?? null,
									rolloutState: d.rolloutState ?? null,
									desired: d.desiredCount ?? null,
									running: d.runningCount ?? null,
									failed: d.failedTasks ?? null,
								})),
							},
							at,
						});
					}
				}

				// 2. ECS naming the failure itself, in its own event stream.
				for (const ev of svc.events ?? []) {
					const ts = ev.createdAt ? new Date(ev.createdAt).getTime() : 0;
					if (ts <= eventSince) continue;
					if (ts > newestEvent) newestEvent = ts;
					const message = ev.message ?? "";
					const match = classifyServiceEvent(message);
					if (!match) continue;
					const key = `tasks:${resource}:event:${match.label}`;
					stillFailing.add(key);
					if (!state.shouldAlert(key, REALERT_MS)) continue;
					state.markAlerted(key, "tasks");
					findings.push({
						family: "tasks",
						severity: match.severity,
						resource,
						summary: `ECS service ${resource} reporting ${match.label}: ${message}`,
						dedup_key: key,
						evidence: {
							cluster,
							service: name,
							classification: match.label,
							message,
							eventAt: ev.createdAt ?? null,
							desiredCount: desired,
							runningCount: running,
							taskDefinition: svc.taskDefinition ?? null,
						},
						at,
					});
				}

				// 3. Sustained shortfall. The duration gate is the whole point:
				// without it this fires on every deployment.
				if (short && (prev[resource] ?? "").startsWith("short:")) {
					const key = `tasks:${resource}:below-desired`;
					stillFailing.add(key);
					if (state.shouldAlert(key, REALERT_MS)) {
						state.markAlerted(key, "tasks");
						findings.push({
							family: "tasks",
							severity: "warn",
							resource,
							summary: `ECS service ${resource} running ${running}/${desired} tasks for 2 cycles`,
							dedup_key: key,
							evidence: {
								cluster,
								service: name,
								desiredCount: desired,
								runningCount: running,
								pendingCount: svc.pendingCount ?? null,
								launchType: svc.launchType ?? null,
								taskDefinition: svc.taskDefinition ?? null,
								previousCycle: prev[resource] ?? null,
							},
							at,
						});
					}
				}
				if (findings.length >= MAX_FINDINGS) {
					truncated = true;
					break;
				}
			}
			if (truncated) break;
		}
		if (truncated) break;
	}

	// Merge rather than replace when the scan was capped, so a service this
	// cycle never reached keeps the previous-cycle state its duration gate
	// depends on.
	state.setSnapshot("ecs-services", truncated ? { ...prev, ...current } : current);
	// A capped scan must not advance the watermark either: events belonging to
	// the services it never read would be skipped permanently. Re-reading them
	// next cycle costs nothing, because the fingerprints dedup them.
	if (!truncated) {
		// Bounded by this scan's start for the same reason the guardduty
		// watermark is: an event created during the scan must be seen again next
		// cycle, not skipped past.
		state.setWatermark("tasks:events", Math.min(newestEvent, now));
	}
	// Recovery sweep, restricted two ways. Only services actually scanned can
	// be judged recovered. And only the two state-derived signals are swept at
	// all: an event-derived fingerprint cannot be cleared by the absence of a
	// new event, because events are a stream rather than a state -- doing so
	// re-armed the alert on the first quiet cycle and defeated the 24 h window.
	// Those expire through REALERT_MS instead.
	for (const key of state.alertKeys("tasks:")) {
		const m = key.match(/^tasks:(.+):(rollout-failed|below-desired)$/);
		if (!m) continue;
		if (!scanned.has(m[1] as string)) continue;
		if (!stillFailing.has(key)) state.clearAlerts(key);
	}
	return findings;
}

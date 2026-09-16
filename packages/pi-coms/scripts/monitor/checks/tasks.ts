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

// Phrases ECS emits on its own service event stream when something is wrong.
// Everything else it emits ("has started 1 tasks", "has begun draining") is
// routine and must never match.
const EVENT_FAILURES: { pattern: RegExp; severity: Severity; label: string }[] = [
	{ pattern: /unable to consistently start tasks successfully/i, severity: "critical", label: "crash loop" },
	{
		pattern: /was unable to place a task because no container instance met all of its requirements/i,
		severity: "warn",
		label: "no capacity",
	},
	{ pattern: /failed container health checks/i, severity: "warn", label: "failing health checks" },
	{
		pattern: /unable to (?:pull|retrieve) (?:secrets|container image|registry auth)/i,
		severity: "warn",
		label: "image or secret pull failure",
	},
	{ pattern: /ResourceInitializationError/i, severity: "warn", label: "resource initialization failure" },
];

export type CheckTasksOpts = { now?: number };

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
					const match = EVENT_FAILURES.find((f) => f.pattern.test(message));
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
				if (findings.length >= MAX_FINDINGS) break;
			}
			if (findings.length >= MAX_FINDINGS) break;
		}
		if (findings.length >= MAX_FINDINGS) break;
	}

	state.setSnapshot("ecs-services", current);
	// Bounded by this scan's start for the same reason the guardduty watermark
	// is: an event created during the scan must be seen again next cycle, not
	// skipped past.
	state.setWatermark("tasks:events", Math.min(newestEvent, now));
	for (const key of state.alertKeys("tasks:")) {
		if (!stillFailing.has(key)) state.clearAlerts(key);
	}
	return findings;
}

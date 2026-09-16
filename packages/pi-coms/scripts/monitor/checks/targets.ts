// scripts/monitor/checks/targets.ts
import {
	DescribeTargetGroupsCommand,
	type DescribeTargetGroupsCommandOutput,
	DescribeTargetHealthCommand,
	type DescribeTargetHealthCommandOutput,
	type TargetGroup,
} from "@aws-sdk/client-elastic-load-balancing-v2";
import type { Finding, Severity } from "../report.ts";
import type { MonitorState } from "../state.ts";
import type { AwsClient } from "./alarms.ts";

// SIO-1748: elasticloadbalancing:DescribeTargetHealth was granted and unread.
// Unlike every pre-existing check, this reads continuous operational state
// whose healthy value is not zero, so the raw state is NOT the signal.
//
// Two mechanics produce unhealthy targets constantly and neither is a fault:
// a rolling deployment drains old targets while new ones register, and a
// scale-out registers targets that fail health checks until they warm up.
// Both resolve within minutes. So "initial" and "draining" are excluded
// outright, and a target must be unhealthy across TWO CONSECUTIVE CYCLES
// (30 min at the default cadence) before it is a finding. A failure persists;
// a deployment does not.
//
// "unused" (no load balancer attached) and "unavailable" (health checks
// disabled) are states of the configuration, not of the target: neither
// means a request would fail, so neither is read here.
const FAILING_STATE = "unhealthy";
const TRANSIENT_STATES = new Set(["initial", "draining"]);
const REALERT_MS = 86_400_000;
// One cycle's worth of findings; an AZ event can take every group at once and
// the report must stay readable (checks/logs.ts uses the same shape).
const MAX_FINDINGS = 10;
const SUMMARY_TARGETS = 5;

export type CheckTargetsOpts = { now?: number };

type UnhealthyTarget = { id: string; port: number | null; reason: string | null; description: string | null };

function targetKey(id: string, port: number | null): string {
	return port === null ? id : `${id}:${port}`;
}

function healthCheckOf(g: TargetGroup): Record<string, unknown> {
	return {
		protocol: g.HealthCheckProtocol ?? null,
		path: g.HealthCheckPath ?? null,
		port: g.HealthCheckPort ?? null,
		intervalSeconds: g.HealthCheckIntervalSeconds ?? null,
		timeoutSeconds: g.HealthCheckTimeoutSeconds ?? null,
		healthyThreshold: g.HealthyThresholdCount ?? null,
		unhealthyThreshold: g.UnhealthyThresholdCount ?? null,
		matcher: g.Matcher?.HttpCode ?? g.Matcher?.GrpcCode ?? null,
	};
}

// The state partition, which is where the discriminator lives. Exported so the
// real-corpus test drives it with production TargetHealthDescriptions rather
// than a fake ELBv2 client.
export function partitionTargets(
	descriptions: {
		Target?: { Id?: string; Port?: number };
		TargetHealth?: { State?: string; Reason?: string; Description?: string };
	}[],
): { settled: number; healthy: number; unhealthy: UnhealthyTarget[] } {
	const unhealthy: UnhealthyTarget[] = [];
	let healthy = 0;
	let settled = 0;
	for (const d of descriptions) {
		const st = d.TargetHealth?.State ?? "unknown";
		if (TRANSIENT_STATES.has(st)) continue;
		settled++;
		if (st === "healthy") healthy++;
		if (st !== FAILING_STATE) continue;
		unhealthy.push({
			id: d.Target?.Id ?? "unknown",
			port: d.Target?.Port ?? null,
			reason: d.TargetHealth?.Reason ?? null,
			description: d.TargetHealth?.Description ?? null,
		});
	}
	return { settled, healthy, unhealthy };
}

// SIO-1752: severity follows the reason code, not the healthy count alone.
//
// The first version rated zero healthy targets critical on the premise that the
// group was serving nothing. AWS documents the opposite: "If a target group
// contains only unhealthy registered targets, the load balancer routes requests
// to all those targets, regardless of their health status ... the load balancer
// fails open." So zero healthy does NOT by itself mean an outage.
//
// What decides it is whether the targets are answering. Target.ResponseCodeMismatch
// means the target responded, just not with the status the matcher expects --
// grafana redirecting / to its login page with a 302, an app that serves no root
// path and says 404. Under fail-open those requests are served normally; the
// health check is asking the wrong question. That is a real misconfiguration
// (there is no failover margin if a target genuinely dies) and worth a warn, but
// it is not an outage. Verified against production: five eu-b2b-ecom-prd target
// groups sat in exactly this state for the whole 14-day history window, fully
// serving traffic, and the old rule would have paged five criticals a day.
//
// Targets that are NOT answering -- Timeout, FailedHealthChecks, anything else,
// or no reason at all -- still make zero healthy critical, because fail-open then
// routes traffic to targets that cannot serve it and clients get 502s. An absent
// or unrecognised reason is deliberately treated as not answering: the rating is
// never downgraded without evidence that the target responded.
export const MISMATCH_REASON = "Target.ResponseCodeMismatch";

export function assessTargetGroup(
	healthy: number,
	unhealthy: { reason: string | null }[],
): { severity: Severity; misconfigured: boolean } {
	const misconfigured = unhealthy.length > 0 && unhealthy.every((t) => t.reason === MISMATCH_REASON);
	if (misconfigured) return { severity: "warn", misconfigured: true };
	return { severity: healthy === 0 ? "critical" : "warn", misconfigured: false };
}

// The status codes a mismatch actually returned, read from the description
// ("Health checks failed with these codes: [302]"), so the finding names what
// the check got rather than only that it was wrong.
export function mismatchCodes(unhealthy: { description: string | null }[]): string[] {
	const codes = new Set<string>();
	for (const t of unhealthy) {
		const m = (t.description ?? "").match(/codes:\s*\[([^\]]*)\]/);
		for (const c of (m?.[1] ?? "")
			.split(",")
			.map((x) => x.trim())
			.filter(Boolean))
			codes.add(c);
	}
	return [...codes].sort();
}

export async function checkTargets(
	client: AwsClient,
	state: MonitorState,
	opts: CheckTargetsOpts = {},
): Promise<Finding[]> {
	const now = opts.now ?? Date.now();
	const at = new Date(now).toISOString();
	const findings: Finding[] = [];

	const groups: TargetGroup[] = [];
	let marker: string | undefined;
	do {
		const resp = (await client.send(
			new DescribeTargetGroupsCommand({ Marker: marker }),
		)) as DescribeTargetGroupsCommandOutput;
		groups.push(...(resp.TargetGroups ?? []));
		marker = resp.NextMarker;
	} while (marker);

	const prev = state.getSnapshot("target-health") ?? {};
	const current: Record<string, string> = {};
	const stillFailing = new Set<string>();
	// Same hazard as checks/tasks.ts: a capped scan that replaced the snapshot
	// would reset the two-cycle gate for every group it never reached.
	const scanned = new Set<string>();
	let truncated = false;

	for (const g of groups) {
		const arn = g.TargetGroupArn;
		if (!arn) continue;
		const name = g.TargetGroupName ?? arn.split("/").slice(-2, -1)[0] ?? arn;

		const health = (await client.send(
			new DescribeTargetHealthCommand({ TargetGroupArn: arn }),
		)) as DescribeTargetHealthCommandOutput;
		const descriptions = health.TargetHealthDescriptions ?? [];

		const { settled, healthy, unhealthy } = partitionTargets(descriptions);

		const keys = unhealthy.map((t) => targetKey(t.id, t.port)).sort();
		current[arn] = keys.join(",");
		scanned.add(name);
		// A group with no settled targets is mid-deployment or empty by design,
		// never an outage: there is nothing registered that could be failing.
		if (settled === 0 || unhealthy.length === 0) continue;

		// The duration gate. Only targets that were ALSO unhealthy last cycle
		// count; a target that appeared unhealthy this cycle alone is still
		// inside the window a deployment or a warm-up occupies.
		const previous = new Set((prev[arn] ?? "").split(",").filter(Boolean));
		const persistent = unhealthy.filter((t) => previous.has(targetKey(t.id, t.port)));
		if (persistent.length === 0) continue;

		// Rated from every currently unhealthy target, not only the persistent
		// ones: fail-open routes traffic to all of them, so whether any of them
		// cannot answer is what decides between a misconfiguration and 502s.
		// The two-cycle gate still decides WHETHER to report; this decides how
		// severely.
		const { severity, misconfigured } = assessTargetGroup(healthy, unhealthy);
		const codes = misconfigured ? mismatchCodes(unhealthy) : [];
		const key = `targets:${name}:unhealthy`;
		stillFailing.add(key);
		if (!state.shouldAlert(key, REALERT_MS)) continue;
		state.markAlerted(key, "targets");

		const shown = persistent
			.slice(0, SUMMARY_TARGETS)
			.map((t) => targetKey(t.id, t.port))
			.join(", ");
		const more = persistent.length > SUMMARY_TARGETS ? ` (+${persistent.length - SUMMARY_TARGETS} more)` : "";
		findings.push({
			family: "targets",
			severity,
			resource: name,
			summary: misconfigured
				? `Target group ${name} health check misconfigured: ${persistent.length}/${settled} targets answer with ${
						codes.length > 0 ? `status ${codes.join("/")}` : "an unexpected status"
					} for 2 cycles (traffic still served, load balancer fails open): ${shown}${more}`
				: healthy === 0
					? `Target group ${name} has no healthy targets and they are not answering (${persistent.length}/${settled} unhealthy for 2 cycles; fail-open is routing to them): ${shown}${more}`
					: `Target group ${name} has ${persistent.length}/${settled} targets unhealthy for 2 cycles: ${shown}${more}`,
			dedup_key: key,
			evidence: {
				targetGroupArn: arn,
				protocol: g.Protocol ?? null,
				port: g.Port ?? null,
				targetType: g.TargetType ?? null,
				vpcId: g.VpcId ?? null,
				healthyCount: healthy,
				settledCount: settled,
				// The reason codes (Target.FailedHealthChecks, Target.Timeout,
				// Target.ResponseCodeMismatch) decide the diagnosis, so they ship
				// with the finding rather than costing the spoke a round trip.
				unhealthy: persistent,
				healthCheck: healthCheckOf(g),
			},
			at,
		});
		if (findings.length >= MAX_FINDINGS) {
			truncated = true;
			break;
		}
	}

	state.setSnapshot("target-health", truncated ? { ...prev, ...current } : current);
	// Recovery: a group that is no longer failing re-arms, so the next genuine
	// outage alerts immediately instead of waiting out the re-alert window.
	// Only groups actually scanned this cycle can be judged recovered.
	for (const key of state.alertKeys("targets:")) {
		const m = key.match(/^targets:(.+):unhealthy$/);
		if (!m || !scanned.has(m[1] as string)) continue;
		if (!stillFailing.has(key)) state.clearAlerts(key);
	}
	return findings;
}

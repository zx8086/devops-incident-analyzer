// scripts/monitor/checks/drift.ts
import {
	DescribeInstanceStatusCommand,
	type DescribeInstanceStatusCommandOutput,
	DescribeInstancesCommand,
	type DescribeInstancesCommandOutput,
	DescribeVolumeStatusCommand,
	type DescribeVolumeStatusCommandOutput,
} from "@aws-sdk/client-ec2";
import type { Finding, Severity } from "../report.ts";
import type { MonitorState } from "../state.ts";
import type { AwsClient } from "./alarms.ts";

const BAD_STATES = new Set(["stopped", "stopping", "terminated", "shutting-down"]);
const OK_STATUS = new Set(["ok", "not-applicable", "initializing"]);
// SIO-1750: volume health belongs to the instances this check already tracks,
// so it goes in this family rather than a new one -- an impaired volume and a
// failing status check are the same conversation about the same host.
// DescribeVolumeStatus reports "ok" for a healthy volume; anything else is EC2
// asserting degradation. Its Actions list is the more interesting half: a
// pending action is AWS telling you it intends to retire or replace the
// underlying hardware, which is advance warning rather than an outage.
const VOLUME_OK = "ok";
// Ids named in a batch summary; the full list is in the evidence.
const SUMMARY_IDS = 10;

// One cause moves many instances at once (a Karpenter node replacement took
// 85 drift findings and 44 investigations on one account in a day, SIO-1676),
// so same-transition changes in one cycle collapse into a single finding:
// one report line, one investigation, and one resource for the budget. A
// lone change keeps the per-instance shape and dedup key.
type Change = { id: string; was: string; now: string };

function batchOrSingle(changes: Change[], single: (c: Change) => Finding, batch: (cs: Change[]) => Finding): Finding[] {
	if (changes.length === 0) return [];
	if (changes.length === 1) return [single(changes[0] as Change)];
	return [batch(changes)];
}

function idList(changes: Change[]): string {
	const ids = changes.map((c) => c.id);
	const shown = ids.slice(0, SUMMARY_IDS).join(", ");
	return ids.length > SUMMARY_IDS ? `${shown} (+${ids.length - SUMMARY_IDS} more)` : shown;
}

// Exported so the real captured volume shape can be asserted directly. An
// impaired volume is a fault; a pending AWS action is advance warning that the
// underlying hardware is going to be retired or replaced, which is information
// rather than an incident.
export function classifyVolume(status: string, actionCount: number): Severity | null {
	if (status !== VOLUME_OK) return "warn";
	return actionCount > 0 ? "info" : null;
}

export async function checkDrift(client: AwsClient, state: MonitorState): Promise<Finding[]> {
	const findings: Finding[] = [];
	const now = new Date().toISOString();

	const di = (await client.send(new DescribeInstancesCommand({}))) as DescribeInstancesCommandOutput;
	const current: Record<string, string> = {};
	for (const r of di.Reservations ?? []) {
		for (const i of r.Instances ?? []) {
			if (i.InstanceId) current[i.InstanceId] = i.State?.Name ?? "unknown";
		}
	}

	// State-change findings are edge-triggered by the snapshot diff, so they
	// need no fingerprints; the first run only establishes the baseline.
	const prev = state.getSnapshot("instances");
	if (prev !== null) {
		const added: Change[] = [];
		const transitions = new Map<string, Change[]>();
		const gone: Change[] = [];
		for (const [id, st] of Object.entries(current)) {
			const was = prev[id];
			if (was === undefined) added.push({ id, was: "", now: st });
			else if (was !== st) {
				const key = `${was}->${st}`;
				transitions.set(key, [...(transitions.get(key) ?? []), { id, was, now: st }]);
			}
		}
		for (const id of Object.keys(prev)) {
			if (!(id in current)) gone.push({ id, was: prev[id] ?? "unknown", now: "" });
		}
		const stamp = now.slice(0, 16); // minute precision keys one cycle's batch

		findings.push(
			...batchOrSingle(
				added,
				(c) => ({
					family: "drift",
					severity: "info",
					resource: c.id,
					summary: `New instance ${c.id} (${c.now})`,
					dedup_key: `drift:${c.id}:new`,
					evidence: { state: c.now },
					at: now,
				}),
				(cs) => ({
					family: "drift",
					severity: "info",
					resource: "ec2:batch",
					summary: `${cs.length} new instances in one cycle: ${idList(cs)}`,
					dedup_key: `drift:batch:new:${stamp}`,
					evidence: { count: cs.length, instances: cs.map((c) => ({ id: c.id, state: c.now })) },
					at: now,
				}),
			),
		);
		for (const [key, cs] of transitions) {
			const to = cs[0]?.now ?? "";
			const severity = BAD_STATES.has(to) ? "warn" : "info";
			findings.push(
				...batchOrSingle(
					cs,
					(c) => ({
						family: "drift",
						severity,
						resource: c.id,
						summary: `Instance ${c.id} changed state ${c.was} -> ${c.now}`,
						dedup_key: `drift:${c.id}:state:${c.now}`,
						evidence: { from: c.was, to: c.now },
						at: now,
					}),
					(batch) => ({
						family: "drift",
						severity,
						resource: "ec2:batch",
						summary: `${batch.length} instances changed state ${key} in one cycle: ${idList(batch)}`,
						dedup_key: `drift:batch:state:${to}:${stamp}`,
						evidence: { count: batch.length, from: batch[0]?.was, to, instances: batch.map((c) => c.id) },
						at: now,
					}),
				),
			);
		}
		findings.push(
			...batchOrSingle(
				gone,
				(c) => ({
					family: "drift",
					severity: "warn",
					resource: c.id,
					summary: `Instance ${c.id} disappeared (was ${c.was})`,
					dedup_key: `drift:${c.id}:gone`,
					evidence: { was: c.was },
					at: now,
				}),
				(cs) => ({
					family: "drift",
					severity: "warn",
					resource: "ec2:batch",
					summary: `${cs.length} instances disappeared in one cycle: ${idList(cs)}`,
					dedup_key: `drift:batch:gone:${stamp}`,
					evidence: { count: cs.length, instances: cs.map((c) => ({ id: c.id, was: c.was })) },
					at: now,
				}),
			),
		);
	}
	state.setSnapshot("instances", current);

	const ds = (await client.send(
		new DescribeInstanceStatusCommand({ IncludeAllInstances: false }),
	)) as DescribeInstanceStatusCommandOutput;
	const failedNow = new Set<string>();
	for (const s of ds.InstanceStatuses ?? []) {
		const id = s.InstanceId ?? "unknown";
		const sys = s.SystemStatus?.Status ?? "ok";
		const inst = s.InstanceStatus?.Status ?? "ok";
		const failed = !OK_STATUS.has(sys) || !OK_STATUS.has(inst);
		if (!failed) continue;
		failedNow.add(id);
		const key = `drift:${id}:statuscheck`;
		if (!state.shouldAlert(key)) continue;
		state.markAlerted(key, "drift");
		findings.push({
			family: "drift",
			severity: "warn",
			resource: id,
			summary: `Instance ${id} failing status check (system=${sys} instance=${inst})`,
			dedup_key: key,
			evidence: { system: sys, instance: inst },
			at: now,
		});
	}
	// Recovery: clear fingerprints for instances no longer failing.
	for (const key of state.alertKeys("drift:")) {
		const m = key.match(/^drift:(.+):statuscheck$/);
		if (m && !failedNow.has(m[1])) state.clearAlerts(key);
	}

	// Paginated, and the completeness of the walk is tracked, because the
	// recovery sweep below can only judge a volume recovered if it was actually
	// looked at. Note there is no IncludeAllVolumes parameter on this API --
	// the accepted inputs are MaxResults, NextToken, VolumeIds,
	// IncludeManagedResources, DryRun and Filters -- and the default response
	// already carries healthy volumes, which is what makes the pending-action
	// signal reachable at all.
	const volumeStatuses: NonNullable<DescribeVolumeStatusCommandOutput["VolumeStatuses"]> = [];
	let volumeToken: string | undefined;
	let volumeScanComplete = true;
	try {
		do {
			const vs = (await client.send(
				new DescribeVolumeStatusCommand({ NextToken: volumeToken }),
			)) as DescribeVolumeStatusCommandOutput;
			volumeStatuses.push(...(vs.VolumeStatuses ?? []));
			volumeToken = vs.NextToken;
		} while (volumeToken);
	} catch {
		// A denied or throttled page must not let the sweep below mistake the
		// volumes it never saw for recovered ones.
		volumeScanComplete = false;
	}

	const volumeFailing = new Set<string>();
	for (const v of volumeStatuses) {
		const id = v.VolumeId ?? "unknown";
		const status = v.VolumeStatus?.Status ?? VOLUME_OK;
		const actions = v.Actions ?? [];
		const severity = classifyVolume(status, actions.length);
		if (severity === null) continue;
		const impaired = status !== VOLUME_OK;
		const key = `drift:${id}:volume`;
		volumeFailing.add(key);
		if (!state.shouldAlert(key)) continue;
		state.markAlerted(key, "drift");
		findings.push({
			family: "drift",
			severity,
			resource: id,
			summary: impaired
				? `Volume ${id} status ${status}`
				: `Volume ${id} has ${actions.length} pending AWS action(s): ${actions.map((a) => a.Code ?? "action").join(", ")}`,
			evidence: {
				volumeId: id,
				status,
				availabilityZone: v.AvailabilityZone ?? null,
				// The events carry AWS's own description of what is wrong or what
				// is scheduled, so the diagnosis starts from their words.
				events: (v.Events ?? []).map((e) => ({
					type: e.EventType ?? null,
					description: e.Description ?? null,
					notBefore: e.NotBefore ?? null,
				})),
				actions: actions.map((a) => ({ code: a.Code ?? null, description: a.Description ?? null })),
			},
			dedup_key: key,
			at: now,
		});
	}
	if (volumeScanComplete) {
		for (const key of state.alertKeys("drift:")) {
			const m = key.match(/^drift:(.+):volume$/);
			if (m && !volumeFailing.has(key)) state.clearAlerts(key);
		}
	}
	return findings;
}

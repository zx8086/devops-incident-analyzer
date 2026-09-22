// scripts/monitor/checks/nodegroups.ts
import {
	DescribeNodegroupCommand,
	type DescribeNodegroupCommandOutput,
	ListClustersCommand,
	type ListClustersCommandOutput,
	ListNodegroupsCommand,
	type ListNodegroupsCommandOutput,
} from "@aws-sdk/client-eks";
import { type Finding, overflowFinding, type Severity } from "../report.ts";
import type { MonitorState } from "../state.ts";
import type { AwsClient } from "./alarms.ts";

// SIO-1750. eks:ListClusters and DescribeCluster were already granted, but
// neither carries node health: DescribeCluster returns no `health` field at
// all (verified against the fleet's one real cluster), so a nodegroup whose
// nodes cannot join was invisible.
//
// The discriminator is AWS's own assertion twice over. `health.issues` is a
// list EKS populates when it has diagnosed a problem itself -- each entry
// carries a code, a message and the resource ids -- and `status` is a closed
// enum where DEGRADED and CREATE_FAILED mean what they say. Neither needs a
// threshold, and the healthy case is an empty array.
const FAILED_STATUS = new Set(["CREATE_FAILED", "DELETE_FAILED", "DEGRADED"]);
const REALERT_MS = 86_400_000;
const MAX_FINDINGS = 10;

export type CheckNodegroupsOpts = { now?: number };

export function severityForNodegroup(status: string, issueCount: number): Severity | null {
	if (FAILED_STATUS.has(status)) return "critical";
	// Issues without a failed status: the group still serves, but EKS has
	// diagnosed something that will bite later (an unreachable AMI, a missing
	// IAM permission, insufficient subnet addresses).
	if (issueCount > 0) return "warn";
	return null;
}

export async function checkNodegroups(
	client: AwsClient,
	state: MonitorState,
	opts: CheckNodegroupsOpts = {},
): Promise<Finding[]> {
	const now = opts.now ?? Date.now();
	const at = new Date(now).toISOString();
	const findings: Finding[] = [];
	const stillFailing = new Set<string>();

	const clusters: string[] = [];
	let clusterToken: string | undefined;
	do {
		const resp = (await client.send(new ListClustersCommand({ nextToken: clusterToken }))) as ListClustersCommandOutput;
		clusters.push(...(resp.clusters ?? []));
		clusterToken = resp.nextToken;
	} while (clusterToken);
	// No EKS in the account is a fact about the account, not a failed check --
	// the same posture the guardduty check takes to a missing detector.

	let truncated = false;
	let omitted = 0;
	const pending: { cluster: string; name: string }[] = [];
	for (const cluster of clusters) {
		let ngToken: string | undefined;
		do {
			const resp = (await client.send(
				new ListNodegroupsCommand({ clusterName: cluster, nextToken: ngToken }),
			)) as ListNodegroupsCommandOutput;
			for (const name of resp.nodegroups ?? []) pending.push({ cluster, name });
			ngToken = resp.nextToken;
		} while (ngToken);
	}

	for (const [i, { cluster, name }] of pending.entries()) {
		const resp = (await client.send(
			new DescribeNodegroupCommand({ clusterName: cluster, nodegroupName: name }),
		)) as DescribeNodegroupCommandOutput;
		const ng = resp.nodegroup;
		if (!ng) continue;
		const status = ng.status ?? "unknown";
		const issues = ng.health?.issues ?? [];
		const severity = severityForNodegroup(status, issues.length);
		const resource = `${cluster}/${name}`;
		if (severity === null) continue;

		const key = `nodegroups:${resource}:${status}`;
		stillFailing.add(key);
		if (state.shouldAlert(key, REALERT_MS)) {
			state.markAlerted(key, "nodegroups");
			findings.push({
				family: "nodegroups",
				severity,
				resource,
				summary: `EKS nodegroup ${resource} is ${status}${
					issues.length > 0 ? `: ${issues.map((x) => x.code ?? "issue").join(", ")}` : ""
				}`,
				dedup_key: key,
				evidence: {
					cluster,
					nodegroup: name,
					status,
					// EKS names the cause and the affected ids itself, so the spoke
					// starts from a diagnosis rather than from a symptom.
					issues: issues.map((x) => ({
						code: x.code ?? null,
						message: x.message ?? null,
						resourceIds: x.resourceIds ?? [],
					})),
					scalingConfig: ng.scalingConfig ?? null,
					instanceTypes: ng.instanceTypes ?? null,
					capacityType: ng.capacityType ?? null,
					amiType: ng.amiType ?? null,
					version: ng.version ?? null,
				},
				at,
			});
		}
		if (findings.length >= MAX_FINDINGS) {
			truncated = true;
			omitted = pending.length - (i + 1);
			break;
		}
	}

	if (omitted > 0) findings.push(overflowFinding("nodegroups", omitted, MAX_FINDINGS, at));
	// Recovery re-arms only when the whole estate was seen; a truncated scan
	// cannot tell a recovered nodegroup from one it never reached.
	if (!truncated) {
		for (const key of state.alertKeys("nodegroups:")) {
			if (!stillFailing.has(key)) state.clearAlerts(key);
		}
	}
	return findings;
}

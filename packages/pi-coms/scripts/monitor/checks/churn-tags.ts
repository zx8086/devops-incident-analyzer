// scripts/monitor/checks/churn-tags.ts
import { GetResourcesCommand, type GetResourcesCommandOutput } from "@aws-sdk/client-resource-groups-tagging-api";
import type { AwsClient } from "./alarms.ts";

// SIO-1868: an autoscaler's resources are created and destroyed continuously,
// so a rule that flags them fires every day about something that is the
// account's designed steady state. The id-prefix suppression in
// deploy/suppressions.yaml cannot tell those apart from STABLE untagged
// resources (an AWS-managed NAT/ELB/EKS-control-plane ENI); an ownership tag
// can.
//
// Measured on eu-mendix-platform-prd, 2026-09-22: of 64 flagged live
// ENIs+instances, 48 carry one of these keys and 14 are AWS-managed interfaces
// carrying no tags at all.
//
// Karpenter tags what IT creates; the VPC CNI tags the secondary pod ENIs it
// attaches, and those are over half the noise -- the Karpenter keys alone would
// catch 28 of 48. Both families are listed for that reason.
export const DEFAULT_CHURN_TAG_KEYS = [
	"karpenter.sh/nodepool",
	"karpenter.sh/nodeclaim",
	"karpenter.k8s.aws/ec2nodeclass",
	"eks:eni:owner",
	"node.k8s.amazonaws.com/instance_id",
] as const;

// `karpenter.sh/discovery` is deliberately ABSENT: it is a selector tag put on
// long-lived subnets and security groups so Karpenter can find them, not a mark
// of something Karpenter created. Including it would hide exactly the stable
// infrastructure this classifier exists to keep visible.
//
// The EBS CSI driver's keys (`ebs.csi.aws.com/cluster`,
// `kubernetes.io/created-for/pvc/name`) are absent for a different reason: the
// 115 volumes carrying them in eu-mendix-platform-prd are PersistentVolumes,
// some created in 2024, so they are a standing tagging gap rather than churn.
// The snapshot diff only reports newly-flagged pairs, so they do not recur
// daily the way an ENI does, and hiding untagged data volumes forever is worth
// more scrutiny than a digest line. Add them per account via
// PI_MONITOR_CHURN_TAGS if that judgement changes.

export function parseChurnTagKeys(raw: string | undefined): string[] {
	if (raw === undefined) return [...DEFAULT_CHURN_TAG_KEYS];
	const keys = raw
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
	// An explicitly empty value disables classification rather than falling back
	// to the defaults: it is the kill-switch for this behaviour.
	return keys;
}

// GetResources takes at most 100 ARNs per call.
const ARN_BATCH = 100;

export type ChurnLookup = {
	// Resource ids whose tags say an autoscaler owns them.
	churnOwned: Set<string>;
	// True when every batch answered. On any failure the caller must treat the
	// result as incomplete and report the findings it could not classify: a
	// throttle must never silently suppress a real violation.
	complete: boolean;
	error?: string;
};

export type ArnBuilder = (resourceType: string, resourceId: string) => string | null;

// The resource id is what a Config evaluation carries; GetResources needs an
// ARN. Only the types this classifier can name are looked up -- an unmappable
// type yields null and its finding is reported unclassified, which is the safe
// direction.
export function buildArn(region: string, accountId: string, resourceType: string, resourceId: string): string | null {
	const ec2 = (kind: string): string => `arn:aws:ec2:${region}:${accountId}:${kind}/${resourceId}`;
	switch (resourceType) {
		case "AWS::EC2::NetworkInterface":
			return ec2("network-interface");
		case "AWS::EC2::Instance":
			return ec2("instance");
		case "AWS::EC2::Volume":
			return ec2("volume");
		default:
			return null;
	}
}

/**
 * Look up ownership tags for the given resources.
 *
 * A resource is churn-owned only when GetResources RETURNS it carrying one of
 * the churn keys. An ARN missing from the response is NOT churn: the API omits
 * untagged resources and deleted ones alike, and a live untagged AWS-managed
 * ENI is precisely the finding worth keeping. Absence therefore means "report
 * it", never "hide it".
 */
export async function lookupChurnOwned(client: AwsClient, arns: string[], churnKeys: string[]): Promise<ChurnLookup> {
	const churnOwned = new Set<string>();
	if (arns.length === 0 || churnKeys.length === 0) return { churnOwned, complete: true };
	const keys = new Set(churnKeys);
	for (let i = 0; i < arns.length; i += ARN_BATCH) {
		const batch = arns.slice(i, i + ARN_BATCH);
		try {
			const resp = (await client.send(
				new GetResourcesCommand({ ResourceARNList: batch }),
			)) as GetResourcesCommandOutput;
			for (const m of resp.ResourceTagMappingList ?? []) {
				const arn = m.ResourceARN;
				if (!arn) continue;
				if (!(m.Tags ?? []).some((t) => t.Key !== undefined && keys.has(t.Key))) continue;
				// The id is the last ARN segment for every type buildArn emits.
				const id = arn.slice(arn.lastIndexOf("/") + 1);
				if (id) churnOwned.add(id);
			}
		} catch (e) {
			// Fail OPEN. Whatever was classified before the failure stays (it was a
			// positive tag read, not an inference), but `complete` is false so the
			// caller reports every unclassified finding rather than assuming.
			return { churnOwned, complete: false, error: e instanceof Error ? e.message : String(e) };
		}
	}
	return { churnOwned, complete: true };
}

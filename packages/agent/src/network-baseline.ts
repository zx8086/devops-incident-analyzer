// agent/src/network-baseline.ts
// SIO-1208: deterministic placement baseline for the per-incident network map.
// The SIO-1204 builder is opportunistic -- it only renders what the turn's ReAct
// loop happened to fetch, so an application-level incident (run 9d4818e5: 404s,
// no network keywords) produced networkNodes: 0. This module guarantees the
// minimal workload -> IP -> subnet -> VPC layer on every AWS-scoped turn by
// invoking a bounded set of read tools AFTER the ReAct loop, inside the same
// estate ALS scope, and appending their outputs to toolOutputs where the
// existing buildNetworkTopology picks them up unchanged. Reuses what the LLM
// already fetched (existing describe_tasks/services outputs) before spending
// calls; every step is individually soft-failing and deadline-checked.
import type { ToolOutput } from "@devops-agent/shared";
import { z } from "zod";
import { matchesFocus } from "./correlation/focus-match.ts";

// Default ON (the sub-agent env-tunable idiom): set NETWORK_BASELINE_ENABLED=false
// (or 0) to disable. Inert for non-aws datasources regardless.
export function isNetworkBaselineEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	const v = env.NETWORK_BASELINE_ENABLED;
	return v !== "false" && v !== "0";
}

// Overall wall-clock budget for the whole baseline (all estates fan out in
// parallel, so this bounds added latency per turn). New calls are not STARTED
// past the deadline; an in-flight call is awaited (MCP calls are uncancellable).
const DEFAULT_TIMEOUT_MS = 8000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
export function networkBaselineTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
	const parsed = Number(env.NETWORK_BASELINE_TIMEOUT_MS);
	if (Number.isInteger(parsed) && parsed > 0 && parsed <= MAX_TIMER_DELAY_MS) return parsed;
	return DEFAULT_TIMEOUT_MS;
}

const MAX_CLUSTERS = 3;
const MAX_SERVICES = 2;
const MAX_TASKS = 10;
// When focus matching finds nothing but the estate is this small, take every
// candidate rather than none -- a 3-service estate's placement is still cheap
// and the alternative is the exact empty map this module exists to prevent.
const SMALL_ESTATE_CANDIDATE_CAP = 5;

export type BaselineInvoke = (toolName: string, args: Record<string, unknown>) => Promise<unknown>;

const DescribeServicesJson = z.object({
	services: z.array(z.object({ serviceName: z.string().optional(), clusterArn: z.string().optional() })).optional(),
});
const ListServicesJson = z.object({ serviceArns: z.array(z.string()).optional() });
const ListClustersJson = z.object({ clusterArns: z.array(z.string()).optional() });
const ListTasksJson = z.object({ taskArns: z.array(z.string()).optional() });
const DescribeTasksJson = z.object({
	tasks: z
		.array(
			z.object({
				attachments: z
					.array(
						z.object({
							details: z.array(z.object({ name: z.string().optional(), value: z.string().optional() })).optional(),
						}),
					)
					.optional(),
			}),
		)
		.optional(),
});
const DescribeSubnetsJson = z.object({
	Subnets: z.array(z.object({ SubnetId: z.string().optional(), VpcId: z.string().optional() })).optional(),
});
const DescribeVpcsJson = z.object({
	Vpcs: z.array(z.object({ VpcId: z.string().optional() })).optional(),
});
// EC2 instance fallback (EKS/non-ECS estates): mirrors the InstanceRow/
// ReservationsEnvelope shape in network-topology.ts, kept local since those
// are module-private there and this only needs the Name tag for matching.
const InstanceTags = z.array(z.object({ Key: z.string().optional(), Value: z.string().optional() })).optional();
const InstanceRow = z.object({
	InstanceId: z.string(),
	SubnetId: z.string().optional(),
	Tags: InstanceTags,
});
const DescribeInstancesJson = z.object({
	Reservations: z.array(z.object({ Instances: z.array(InstanceRow).optional() })).optional(),
});

function subnetIdsFromDescribeInstances(rawJson: unknown): string[] {
	const parsed = DescribeInstancesJson.safeParse(rawJson);
	if (!parsed.success) return [];
	return (parsed.data.Reservations ?? [])
		.flatMap((r) => r.Instances ?? [])
		.map((i) => i.SubnetId)
		.filter((id): id is string => typeof id === "string" && id.length > 0);
}

function instanceNameTag(t: z.infer<typeof InstanceTags>): string | undefined {
	return t?.find((x) => x.Key === "Name")?.Value;
}

export type SkippedReason = "no-ecs-tools" | "no-clusters" | "no-focus-match" | "no-tasks-running";
export type FallbackUsed = "ec2-instances";

export interface NetworkBaselineDiagnostics {
	candidatesFound: number;
	candidatesMatched: number;
	focusTokensTried: string[];
	skippedReason?: SkippedReason;
	fallbackUsed?: FallbackUsed;
}

export interface NetworkBaselineResult {
	outputs: ToolOutput[];
	diagnostics: NetworkBaselineDiagnostics;
}

interface CandidateService {
	cluster: string;
	service: string;
}

// EC2-instance candidate: no ECS cluster/service concept, so the "service" match
// string is the instance's Name tag (falling back to the raw instance id).
interface CandidateInstance {
	instanceId: string;
	name: string;
}

// ECS service ARN: arn:aws:ecs:<region>:<acct>:service/<cluster>/<name>.
function candidateFromServiceArn(arn: string): CandidateService | undefined {
	const parts = arn.split("/");
	const service = parts[2];
	const cluster = parts[1];
	if (parts.length === 3 && cluster && service) return { cluster, service };
	return undefined;
}

// Cluster ARN: arn:aws:ecs:<region>:<acct>:cluster/<name>.
function clusterNameFromArn(arn: string): string {
	const slash = arn.lastIndexOf("/");
	return slash >= 0 ? arn.slice(slash + 1) : arn;
}

function candidatesFromOutputs(outputs: ToolOutput[]): CandidateService[] {
	const seen = new Map<string, CandidateService>();
	for (const o of outputs) {
		if (o.toolName === "aws_ecs_describe_services") {
			const parsed = DescribeServicesJson.safeParse(o.rawJson);
			if (!parsed.success) continue;
			for (const svc of parsed.data.services ?? []) {
				if (!svc.serviceName || !svc.clusterArn) continue;
				const cluster = clusterNameFromArn(svc.clusterArn);
				seen.set(`${cluster}/${svc.serviceName}`, { cluster, service: svc.serviceName });
			}
		} else if (o.toolName === "aws_ecs_list_services") {
			const parsed = ListServicesJson.safeParse(o.rawJson);
			if (!parsed.success) continue;
			for (const arn of parsed.data.serviceArns ?? []) {
				const candidate = candidateFromServiceArn(arn);
				if (candidate) seen.set(`${candidate.cluster}/${candidate.service}`, candidate);
			}
		}
	}
	return Array.from(seen.values());
}

function subnetIdsFromDescribeTasks(rawJson: unknown): string[] {
	const parsed = DescribeTasksJson.safeParse(rawJson);
	if (!parsed.success) return [];
	const ids: string[] = [];
	for (const task of parsed.data.tasks ?? []) {
		for (const att of task.attachments ?? []) {
			for (const detail of att.details ?? []) {
				if (detail.name === "subnetId" && detail.value) ids.push(detail.value);
			}
		}
	}
	return ids;
}

function pickCandidates(candidates: CandidateService[], focusServices: string[]): CandidateService[] {
	const matched = candidates.filter((c) => matchesFocus(c.service, focusServices));
	if (matched.length > 0) return matched.slice(0, MAX_SERVICES);
	if (candidates.length > 0 && candidates.length <= SMALL_ESTATE_CANDIDATE_CAP) {
		return candidates.slice(0, MAX_SERVICES);
	}
	return [];
}

function pickInstanceCandidates(candidates: CandidateInstance[], focusServices: string[]): CandidateInstance[] {
	const matched = candidates.filter((c) => matchesFocus(c.name, focusServices));
	if (matched.length > 0) return matched.slice(0, MAX_SERVICES);
	if (candidates.length > 0 && candidates.length <= SMALL_ESTATE_CANDIDATE_CAP) {
		return candidates.slice(0, MAX_SERVICES);
	}
	return [];
}

// EKS (and any other non-ECS) estates have no ECS clusters to enumerate, so
// list_clusters legitimately returns []. The only placement signal left is the
// EC2 instances themselves -- reuses the same InstanceId/Name-tag shape
// network-topology.ts already parses into workload nodes with IPs.
async function fetchInstanceCandidates(
	probe: (toolName: string, args: Record<string, unknown>) => Promise<unknown>,
	focusServices: string[],
): Promise<{ candidates: CandidateInstance[]; matched: CandidateInstance[] }> {
	const instancesJson = await probe("aws_ec2_describe_instances", {});
	const parsed = DescribeInstancesJson.safeParse(instancesJson);
	const rows = (parsed.data?.Reservations ?? []).flatMap((r) => r.Instances ?? []);
	const candidates: CandidateInstance[] = rows.map((row) => ({
		instanceId: row.InstanceId,
		name: instanceNameTag(row.Tags) ?? row.InstanceId,
	}));
	return { candidates, matched: pickInstanceCandidates(candidates, focusServices) };
}

export async function fetchNetworkBaseline(opts: {
	invoke: BaselineInvoke;
	hasTool: (name: string) => boolean;
	existingOutputs: ToolOutput[];
	focusServices: string[];
	timeoutMs?: number;
}): Promise<NetworkBaselineResult> {
	const { invoke, hasTool, existingOutputs, focusServices } = opts;
	const diagnostics: NetworkBaselineDiagnostics = {
		candidatesFound: 0,
		candidatesMatched: 0,
		focusTokensTried: focusServices,
	};
	// Core map-feeding tools; without them the baseline cannot add anything.
	if (!hasTool("aws_ecs_describe_tasks") || !hasTool("aws_ecs_list_tasks") || !hasTool("aws_ec2_describe_subnets")) {
		diagnostics.skippedReason = "no-ecs-tools";
		return { outputs: [], diagnostics };
	}
	const deadline = Date.now() + (opts.timeoutMs ?? networkBaselineTimeoutMs());
	const out: ToolOutput[] = [];

	// Map-feeding calls are recorded onto toolOutputs; discovery probes
	// (list_clusters/list_services/list_tasks) are not -- the builder ignores
	// them and persisting them would only bloat checkpoint state.
	const probe = async (toolName: string, args: Record<string, unknown>): Promise<unknown> => {
		if (Date.now() > deadline || !hasTool(toolName)) return undefined;
		try {
			return await invoke(toolName, args);
		} catch {
			return undefined;
		}
	};
	const record = async (toolName: string, args: Record<string, unknown>): Promise<unknown> => {
		const rawJson = await probe(toolName, args);
		if (rawJson !== undefined) out.push({ toolName, rawJson });
		return rawJson;
	};

	// 1. Task placement. Reuse the ReAct loop's describe_tasks work when present.
	const describeTasksJsons: unknown[] = existingOutputs
		.filter((o) => o.toolName === "aws_ecs_describe_tasks")
		.map((o) => o.rawJson);
	// EC2-instance fallback (EKS estates) has no ECS task shape, so its subnet
	// ids are tracked separately and merged into the subnet gap-fill in step 2.
	const extraSubnetIds: string[] = [];
	if (describeTasksJsons.length === 0) {
		const existingCandidates = candidatesFromOutputs(existingOutputs);
		let candidates = pickCandidates(existingCandidates, focusServices);
		diagnostics.candidatesFound = existingCandidates.length;
		diagnostics.candidatesMatched = candidates.length;
		if (candidates.length === 0) {
			// Enumeration fallback: the turn never touched ECS at all.
			const clustersJson = await probe("aws_ecs_list_clusters", {});
			const clusters = (ListClustersJson.safeParse(clustersJson).data?.clusterArns ?? [])
				.slice(0, MAX_CLUSTERS)
				.map(clusterNameFromArn);
			const discovered: CandidateService[] = [];
			for (const cluster of clusters) {
				const servicesJson = await probe("aws_ecs_list_services", { cluster });
				for (const arn of ListServicesJson.safeParse(servicesJson).data?.serviceArns ?? []) {
					const candidate = candidateFromServiceArn(arn);
					if (candidate) discovered.push(candidate);
				}
			}
			candidates = pickCandidates(discovered, focusServices);
			diagnostics.candidatesFound += discovered.length;
			diagnostics.candidatesMatched = candidates.length;

			// EKS (and any other non-ECS) estate: list_clusters legitimately came
			// back empty, so fall back to EC2 instances -- the only placement
			// signal an EKS estate exposes via these tool names.
			if (candidates.length === 0 && clusters.length === 0 && hasTool("aws_ec2_describe_instances")) {
				const { candidates: instanceCandidates, matched: instanceMatches } = await fetchInstanceCandidates(
					probe,
					focusServices,
				);
				diagnostics.candidatesFound += instanceCandidates.length;
				if (instanceMatches.length > 0) {
					diagnostics.fallbackUsed = "ec2-instances";
					diagnostics.candidatesMatched = instanceMatches.length;
					const instancesJson = await record("aws_ec2_describe_instances", {
						instanceIds: instanceMatches.map((c) => c.instanceId),
					});
					extraSubnetIds.push(...subnetIdsFromDescribeInstances(instancesJson));
				}
			}
		}
		for (const candidate of candidates) {
			const tasksJson = await probe("aws_ecs_list_tasks", {
				cluster: candidate.cluster,
				serviceName: candidate.service,
				desiredStatus: "RUNNING",
				maxResults: MAX_TASKS,
			});
			const taskArns = (ListTasksJson.safeParse(tasksJson).data?.taskArns ?? []).slice(0, MAX_TASKS);
			if (taskArns.length === 0) continue;
			const described = await record("aws_ecs_describe_tasks", { cluster: candidate.cluster, tasks: taskArns });
			if (described !== undefined) describeTasksJsons.push(described);
		}
	}

	// 2. Subnet CIDRs (the ipInCidr placement source), then their VPCs. Gap-fill
	// is COVERAGE-based, not tool-name-based: the loop may have fetched subnets/
	// VPCs for unrelated ids (the ingress protocol does exactly that), so only
	// the ids missing from existing outputs are fetched.
	const subnetIds = [...new Set([...describeTasksJsons.flatMap(subnetIdsFromDescribeTasks), ...extraSubnetIds])];
	const existingSubnetRows = existingOutputs
		.filter((o) => o.toolName === "aws_ec2_describe_subnets")
		.flatMap((o) => DescribeSubnetsJson.safeParse(o.rawJson).data?.Subnets ?? []);
	const knownSubnetIds = new Set(existingSubnetRows.map((s) => s.SubnetId).filter((id) => id));
	const missingSubnetIds = subnetIds.filter((id) => !knownSubnetIds.has(id));
	let subnetsJson: unknown;
	if (missingSubnetIds.length > 0) {
		subnetsJson = await record("aws_ec2_describe_subnets", { subnetIds: missingSubnetIds });
	}
	// VPC ids come from BOTH the fresh fetch and any existing rows covering our
	// subnets, so a fully-covered subnet layer still resolves its VPCs.
	const coveredExistingVpcIds = existingSubnetRows
		.filter((s) => s.SubnetId && subnetIds.includes(s.SubnetId))
		.map((s) => s.VpcId);
	const freshVpcIds = DescribeSubnetsJson.safeParse(subnetsJson).data?.Subnets?.map((s) => s.VpcId) ?? [];
	const vpcIds = [...new Set([...coveredExistingVpcIds, ...freshVpcIds])].filter(
		(id): id is string => typeof id === "string" && id.length > 0,
	);
	const knownVpcIds = new Set(
		existingOutputs
			.filter((o) => o.toolName === "aws_ec2_describe_vpcs")
			.flatMap((o) => DescribeVpcsJson.safeParse(o.rawJson).data?.Vpcs?.map((v) => v.VpcId) ?? []),
	);
	const missingVpcIds = vpcIds.filter((id) => !knownVpcIds.has(id));
	if (missingVpcIds.length > 0) {
		await record("aws_ec2_describe_vpcs", { vpcIds: missingVpcIds });
	}

	// Explain an empty/near-empty result: which stage produced nothing.
	if (!diagnostics.skippedReason && out.length === 0) {
		if (diagnostics.candidatesFound === 0) diagnostics.skippedReason = "no-clusters";
		else if (diagnostics.candidatesMatched === 0) diagnostics.skippedReason = "no-focus-match";
		else diagnostics.skippedReason = "no-tasks-running";
	}
	return { outputs: out, diagnostics };
}

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
	Subnets: z.array(z.object({ VpcId: z.string().optional() })).optional(),
});

interface CandidateService {
	cluster: string;
	service: string;
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

export async function fetchNetworkBaseline(opts: {
	invoke: BaselineInvoke;
	hasTool: (name: string) => boolean;
	existingOutputs: ToolOutput[];
	focusServices: string[];
	timeoutMs?: number;
}): Promise<ToolOutput[]> {
	const { invoke, hasTool, existingOutputs, focusServices } = opts;
	// Core map-feeding tools; without them the baseline cannot add anything.
	if (!hasTool("aws_ecs_describe_tasks") || !hasTool("aws_ecs_list_tasks") || !hasTool("aws_ec2_describe_subnets")) {
		return [];
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
	if (describeTasksJsons.length === 0) {
		let candidates = pickCandidates(candidatesFromOutputs(existingOutputs), focusServices);
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

	// 2. Subnet CIDRs (the ipInCidr placement source), then their VPCs. Skipped
	// when the loop already fetched them -- the baseline only fills gaps.
	const subnetIds = [...new Set(describeTasksJsons.flatMap(subnetIdsFromDescribeTasks))];
	const hasSubnets = existingOutputs.some((o) => o.toolName === "aws_ec2_describe_subnets");
	let subnetsJson: unknown;
	if (subnetIds.length > 0 && !hasSubnets) {
		subnetsJson = await record("aws_ec2_describe_subnets", { subnetIds });
	}
	const vpcIds = [
		...new Set(DescribeSubnetsJson.safeParse(subnetsJson).data?.Subnets?.map((s) => s.VpcId) ?? []),
	].filter((id): id is string => typeof id === "string" && id.length > 0);
	const hasVpcs = existingOutputs.some((o) => o.toolName === "aws_ec2_describe_vpcs");
	if (vpcIds.length > 0 && !hasVpcs) {
		await record("aws_ec2_describe_vpcs", { vpcIds });
	}
	return out;
}

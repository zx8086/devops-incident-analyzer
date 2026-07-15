// packages/agent/src/kg-topology.ts
//
// SIO-1104 (5a): the scheduled topology sweep's collectors + orchestration. Each
// collector maps one live source to parsed topology edges over the already-connected
// MCP bridge (the knowledge-graph writers stay pure/network-free):
//   elastic APM service_destination metrics -> DEPENDS_ON(Service->Service)
//   Konnect route/service configs          -> ROUTES_TO(ApiRoute->Service)
//   Kafka consumer-group describes         -> CONSUMES_FROM(ConsumerGroup->KafkaTopic)
//   AWS ECS enumeration (per estate)       -> RUNS_ON(Service->AwsResource)
// PRODUCES_TO is deliberately not collected: no available tool is a system of record
// for producers, and guessed topology is worse than none (P6).
//
// Every collector returns a `complete` flag: true only when EVERY sub-call
// (estate/deployment/control plane) succeeded. Partial success still writes the
// edges it saw but MUST NOT sweep -- a failed estate's edges would otherwise accrue
// false misses toward invalidation.

import {
	getGraphStore,
	isKnowledgeGraphEnabled,
	recordTopologyEdges,
	serviceNames,
	sweepStaleTopology,
	type TopologyEdgeRecord,
} from "@devops-agent/knowledge-graph";
import { getLogger } from "@devops-agent/observability";
import { normalize } from "@devops-agent/shared";
import { availableAwsEstates } from "./aws-estate-router.ts";
import { getConnectedServers, getToolsForDataSource, withAwsEstate, withElasticDeployment } from "./mcp-bridge.ts";
import {
	parseApmServiceDestinationAgg,
	parseAwsEcsClusterArns,
	parseAwsEcsServices,
	parseKafkaConsumerGroups,
	parseKafkaGroupTopics,
	parseKonnectControlPlanes,
	parseKonnectRoutes,
	parseKonnectServices,
} from "./resolve-identifiers-parsers.ts";
import { normalizeToolContent } from "./sub-agent.ts";

const logger = getLogger("agent:kg-topology");

// Default OFF, unlike the other KG flags: the sweep does live MCP I/O on a schedule.
// Requires the knowledge graph itself to be enabled.
export function topologyCronEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	const v = env.KG_TOPOLOGY_CRON_ENABLED;
	return (v === "true" || v === "1") && isKnowledgeGraphEnabled(env);
}

// K in the K-consecutive-miss invalidation (edge staleness SLO = interval x K).
export function topologyMissThreshold(env: NodeJS.ProcessEnv = process.env): number {
	const parsed = Number(env.KG_TOPOLOGY_MISS_THRESHOLD);
	if (Number.isInteger(parsed) && parsed > 0) return parsed;
	return 3;
}

// The sweep has no per-turn state, so deployments come from ELASTIC_DEPLOYMENTS
// (comma list); unset means the single default deployment (no header scope).
export function configuredElasticDeployments(env: NodeJS.ProcessEnv = process.env): Array<string | undefined> {
	const ids = (env.ELASTIC_DEPLOYMENTS ?? "")
		.split(",")
		.map((s) => s.trim())
		.filter((s) => s.length > 0);
	return ids.length > 0 ? ids : [undefined];
}

// Per-source wall clock. Deliberately generous (this is a background sweep, not the
// 8s pre-fan-out probe budget); the mcp-bridge timeout caveat applies -- a timed-out
// in-flight request is not cancelled, it just stops being awaited.
const SOURCE_TIMEOUT_MS = 60_000;
const APM_WINDOW_GTE = "now-24h";
const APM_INDEX = "metrics-apm.service_destination.1m*";
const APM_INDEX_FALLBACK = "metrics-apm*";
// One kafka_describe_consumer_group per group -- cap the N+1 fan-out. A capped list
// is an INCOMPLETE collection (must not sweep).
const KAFKA_GROUP_CAP = 100;

function msg(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function safeJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}

// [CodeRabbit SIO-1104] A malformed/unparseable tool response must FAIL the
// sub-call (-> complete=false), never read as "legitimately empty": repeated
// drift would otherwise feed an authoritative empty set into the sweep and
// invalidate valid edges after K rounds.
function parseJsonOrThrow(text: string, what: string): unknown {
	const parsed = safeJson(text);
	if (parsed === null) throw new Error(`unparseable ${what} response`);
	return parsed;
}

// Kong list envelopes carry metadata.capped when the 100-row page cap hit.
function kongCapped(json: unknown): boolean {
	if (!json || typeof json !== "object") return false;
	const meta = (json as Record<string, unknown>).metadata;
	return meta !== null && typeof meta === "object" && (meta as Record<string, unknown>).capped === true;
}

// AWS list responses carry nextToken when paginated -- a one-shot read is then
// an incomplete collection.
function hasNextToken(json: unknown): boolean {
	return json !== null && typeof json === "object" && typeof (json as Record<string, unknown>).nextToken === "string";
}

function toolFor(dataSourceId: string, name: string) {
	return getToolsForDataSource(dataSourceId).find((t) => t.name === name);
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<T>((_resolve, reject) => {
		timer = setTimeout(() => reject(new Error(`topology collector timed out after ${ms}ms`)), ms);
		timer.unref?.();
	});
	return Promise.race([p, timeout]).finally(() => {
		if (timer) clearTimeout(timer);
	});
}

export interface CollectorResult {
	kind: TopologyEdgeRecord["kind"];
	edges: TopologyEdgeRecord[];
	// true only when every estate/deployment/control-plane sub-call succeeded AND
	// no listing was truncated. Gates the staleness sweep.
	complete: boolean;
}

function dedupeEdges(edges: TopologyEdgeRecord[]): TopologyEdgeRecord[] {
	const seen = new Set<string>();
	const out: TopologyEdgeRecord[] = [];
	for (const e of edges) {
		const key = `${e.from}\u0000${e.to}`;
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(e);
	}
	return out;
}

// elastic APM exit-span metrics -> DEPENDS_ON. P6 filter: a destination resource is
// kept only when it maps (port-stripped + normalize()) onto another service.name
// observed in the SAME sweep -- Service->Service only; databases, hosts and external
// APIs are dropped. Also returns the raw caller names for the AWS collector's
// name matching.
export async function collectElasticDependencies(): Promise<CollectorResult & { callers: string[] }> {
	const kind = "depends-on" as const;
	const tool = toolFor("elastic", "elasticsearch_search");
	if (!tool) return { kind, edges: [], complete: false, callers: [] };
	const deployments = configuredElasticDeployments();
	const argsFor = (index: string) => ({
		index,
		size: 0,
		query: { bool: { filter: [{ range: { "@timestamp": { gte: APM_WINDOW_GTE } } }] } },
		aggs: {
			by_service: {
				terms: { field: "service.name", size: 500 },
				aggs: { by_dest: { terms: { field: "span.destination.service.resource", size: 100 } } },
			},
		},
	});
	const collectDeployment = async (deploymentId: string | undefined) => {
		const invoke = async (index: string) => {
			const run = () => tool.invoke(argsFor(index));
			const raw = deploymentId ? await withElasticDeployment(deploymentId, run) : await run();
			const text = normalizeToolContent(raw);
			// No JSON at all = a tool error/drift envelope, not an empty agg (a
			// legitimate zero-hit search still returns the aggregations JSON).
			if (!text.includes("{")) throw new Error("unparseable search response");
			return parseApmServiceDestinationAgg(text);
		};
		const result = await invoke(APM_INDEX);
		// Zero buckets can mean the 1m-rollup pattern is absent on this deployment --
		// retry once against the broader metrics-apm* pattern before concluding empty.
		return result.services.length > 0 ? result : invoke(APM_INDEX_FALLBACK);
	};
	const settled = await Promise.allSettled(deployments.map(collectDeployment));
	const pairs: Array<{ service: string; destination: string }> = [];
	const callerSet = new Set<string>();
	let truncated = false;
	settled.forEach((r, i) => {
		if (r.status === "fulfilled") {
			pairs.push(...r.value.pairs);
			for (const s of r.value.services) callerSet.add(s);
			if (r.value.truncated) {
				// A terms agg dropped buckets (sum_other_doc_count > 0): edges are still
				// written but the collection must not sweep (false misses otherwise).
				logger.warn({ deployment: deployments[i] }, "apm service_destination agg truncated; sweep skipped");
				truncated = true;
			}
		} else logger.warn({ deployment: deployments[i], error: msg(r.reason) }, "apm service_destination query failed");
	});
	const callers = [...callerSet];
	const byNormalized = new Map(callers.map((name) => [normalize(name), name]));
	const edges: TopologyEdgeRecord[] = [];
	for (const p of pairs) {
		const canonical = byNormalized.get(normalize(p.destination.replace(/:\d+$/, "")));
		if (!canonical || canonical === p.service) continue;
		edges.push({ kind, from: p.service, to: canonical });
	}
	return {
		kind,
		edges: dedupeEdges(edges),
		complete: !truncated && settled.every((r) => r.status === "fulfilled"),
		callers,
	};
}

// Konnect control planes -> services + routes -> ROUTES_TO. Kong is the system of
// record for its own routing table, so route paths/service names are written as-is.
export async function collectKonnectRoutes(): Promise<CollectorResult> {
	const kind = "routes-to" as const;
	const cpTool = toolFor("konnect", "konnect_list_control_planes");
	const svcTool = toolFor("konnect", "konnect_list_services");
	const routeTool = toolFor("konnect", "konnect_list_routes");
	if (!cpTool || !svcTool || !routeTool) return { kind, edges: [], complete: false };
	const cps = parseKonnectControlPlanes(
		parseJsonOrThrow(normalizeToolContent(await cpTool.invoke({ pageSize: 100 })), "konnect control-plane list"),
	);
	let complete = true;
	const edges: TopologyEdgeRecord[] = [];
	for (const cp of cps) {
		try {
			const servicesJson = parseJsonOrThrow(
				normalizeToolContent(await svcTool.invoke({ controlPlaneId: cp.controlPlaneId, pageSize: 100 })),
				"konnect service list",
			);
			const services = parseKonnectServices(servicesJson);
			if (kongCapped(servicesJson)) {
				// A truncated service list drops serviceId->name joins, silently losing
				// route edges -- the collection must not sweep.
				logger.warn({ controlPlane: cp.name }, "konnect service list truncated at page cap; sweep skipped");
				complete = false;
			}
			const nameByServiceId = new Map(services.filter((s) => s.name).map((s) => [s.serviceId, s.name as string]));
			const { routes, capped } = parseKonnectRoutes(
				parseJsonOrThrow(
					normalizeToolContent(await routeTool.invoke({ controlPlaneId: cp.controlPlaneId, pageSize: 100 })),
					"konnect route list",
				),
			);
			if (capped) {
				// First page only (Kong caps pageSize at 100) -- edges beyond it would
				// accrue false misses, so the sweep is skipped this round.
				logger.warn({ controlPlane: cp.name }, "konnect route list truncated at page cap; sweep skipped");
				complete = false;
			}
			for (const route of routes) {
				const serviceName = route.serviceId ? nameByServiceId.get(route.serviceId) : undefined;
				if (!serviceName) continue;
				for (const path of route.paths) {
					if (path) edges.push({ kind, from: path, to: serviceName });
				}
			}
		} catch (error) {
			logger.warn({ controlPlane: cp.name, error: msg(error) }, "konnect route collection failed for control plane");
			complete = false;
		}
	}
	return { kind, edges: dedupeEdges(edges), complete };
}

// Kafka consumer-group describes -> CONSUMES_FROM. The committed-offset topics are
// the group's actual consumption set (system of record: the broker).
export async function collectKafkaConsumption(): Promise<CollectorResult> {
	const kind = "consumes-from" as const;
	const groupsTool = toolFor("kafka", "kafka_list_consumer_groups");
	const describeTool = toolFor("kafka", "kafka_describe_consumer_group");
	if (!groupsTool || !describeTool) return { kind, edges: [], complete: false };
	// NEVER pass `filter` -- the server compiles it as a raw RegExp and a non-regex
	// token throws MCP -32603. Enumerate unfiltered.
	const all = parseKafkaConsumerGroups(
		parseJsonOrThrow(normalizeToolContent(await groupsTool.invoke({})), "kafka consumer-group list"),
	);
	let complete = true;
	let groups = all;
	if (all.length > KAFKA_GROUP_CAP) {
		logger.warn({ total: all.length, cap: KAFKA_GROUP_CAP }, "kafka group list exceeds describe cap; sweep skipped");
		groups = all.slice(0, KAFKA_GROUP_CAP);
		complete = false;
	}
	const edges: TopologyEdgeRecord[] = [];
	for (const groupId of groups) {
		try {
			const topics = parseKafkaGroupTopics(
				parseJsonOrThrow(normalizeToolContent(await describeTool.invoke({ groupId })), "kafka group describe"),
			);
			for (const topic of topics) edges.push({ kind, from: groupId, to: topic });
		} catch (error) {
			logger.warn({ groupId, error: msg(error) }, "kafka consumer-group describe failed");
			complete = false;
		}
	}
	return { kind, edges: dedupeEdges(edges), complete };
}

// AWS ECS enumeration per estate -> RUNS_ON. P6 name mapping: an ECS service short
// name must match (normalize() equality) a service the graph already knows (or an
// APM caller from this sweep) -- unmatched ECS services are skipped, never invented.
export async function collectAwsRunsOn(knownServiceNames: string[]): Promise<CollectorResult> {
	const kind = "runs-on" as const;
	const clustersTool = toolFor("aws", "aws_ecs_list_clusters");
	const servicesTool = toolFor("aws", "aws_ecs_list_services");
	if (!clustersTool || !servicesTool) return { kind, edges: [], complete: false };
	const estates = await availableAwsEstates();
	if (estates.length === 0) {
		// Config absence is not an observation -- never sweep on it (a temporarily
		// unset AWS_ESTATES must not retire every RUNS_ON edge K sweeps later).
		logger.info("no AWS estates configured; skipping runs-on collection");
		return { kind, edges: [], complete: false };
	}
	const byNormalized = new Map(knownServiceNames.map((name) => [normalize(name), name]));
	let skipped = 0;
	let paginated = false;
	const collectEstate = async (estate: string): Promise<TopologyEdgeRecord[]> =>
		withAwsEstate(estate, async () => {
			const clustersJson = parseJsonOrThrow(normalizeToolContent(await clustersTool.invoke({})), "ecs cluster list");
			if (hasNextToken(clustersJson)) paginated = true;
			const clusters = parseAwsEcsClusterArns(clustersJson);
			const out: TopologyEdgeRecord[] = [];
			for (const cluster of clusters) {
				const servicesJson = parseJsonOrThrow(
					normalizeToolContent(await servicesTool.invoke({ cluster })),
					"ecs service list",
				);
				if (hasNextToken(servicesJson)) paginated = true;
				const services = parseAwsEcsServices(servicesJson);
				for (const svc of services) {
					const canonical = byNormalized.get(normalize(svc.name));
					if (!canonical) {
						skipped++;
						continue;
					}
					out.push({ kind, from: canonical, to: svc.arn });
				}
			}
			return out;
		});
	const settled = await Promise.allSettled(estates.map(collectEstate));
	const edges: TopologyEdgeRecord[] = [];
	settled.forEach((r, i) => {
		if (r.status === "fulfilled") edges.push(...r.value);
		else logger.warn({ estate: estates[i], error: msg(r.reason) }, "aws ecs enumeration failed for estate");
	});
	if (skipped > 0) logger.debug({ skipped }, "ecs services without a matching known Service were skipped (P6)");
	if (paginated) {
		// A one-shot list left a nextToken behind: unseen clusters/services would
		// accrue false misses, so the collection must not sweep.
		logger.warn("ecs listing returned nextToken (one-shot read incomplete); sweep skipped");
	}
	return { kind, edges: dedupeEdges(edges), complete: !paginated && settled.every((r) => r.status === "fulfilled") };
}

export interface TopologySourceSummary {
	edges: number;
	invalidated: number;
	sweepSkipped?: boolean;
	error?: string;
}

export interface TopologySweepSummary {
	skipped?: "disabled" | "bridge-not-connected";
	sources: Record<string, TopologySourceSummary>;
}

// One sweep: per source (only if its MCP server is connected) collect under a wall
// clock, write the fresh edges, and -- only on a complete collection -- run the
// K-miss staleness pass. Sources soft-fail independently. Writes go through THE
// in-process getGraphStore() singleton (embedded lbug holds an exclusive file lock;
// never open a second store).
export async function runTopologySweep(opts: { source?: string } = {}): Promise<TopologySweepSummary> {
	if (!topologyCronEnabled()) return { skipped: "disabled", sources: {} };
	// Bridge connections are established lazily on the first user turn
	// (ensureMcpConnected in apps/web); an early cron tick just waits for the next.
	const connected = new Set(getConnectedServers());
	if (connected.size === 0) {
		logger.info("mcp bridge not connected yet; skipping topology sweep");
		return { skipped: "bridge-not-connected", sources: {} };
	}
	const store = await getGraphStore();
	const maxMisses = topologyMissThreshold();
	const summary: TopologySweepSummary = { sources: {} };

	const runSource = async (source: string, serverName: string, collect: () => Promise<CollectorResult>) => {
		if (!connected.has(serverName)) {
			summary.sources[source] = { edges: 0, invalidated: 0, sweepSkipped: true, error: "server-not-connected" };
			return;
		}
		try {
			const result = await withTimeout(collect(), SOURCE_TIMEOUT_MS);
			await recordTopologyEdges(store, result.edges);
			let invalidated = 0;
			if (result.complete) {
				({ invalidated } = await sweepStaleTopology(store, result.kind, result.edges, { maxMisses }));
			}
			summary.sources[source] = {
				edges: result.edges.length,
				invalidated,
				...(result.complete ? {} : { sweepSkipped: true }),
			};
		} catch (error) {
			summary.sources[source] = { edges: 0, invalidated: 0, sweepSkipped: true, error: msg(error) };
			logger.warn({ source, error: msg(error) }, "topology collector failed; continuing with remaining sources");
		}
	};

	// elastic runs first: its APM caller names feed the AWS collector's P6 matcher.
	let apmCallers: string[] = [];
	await runSource("elastic", "elastic-mcp", async () => {
		const result = await collectElasticDependencies();
		apmCallers = result.callers;
		return result;
	});
	await runSource("konnect", "konnect-mcp", collectKonnectRoutes);
	await runSource("kafka", "kafka-mcp", collectKafkaConsumption);
	await runSource("aws", "aws-mcp", async () => {
		const known = new Set([...(await serviceNames(store)), ...apmCallers]);
		return collectAwsRunsOn([...known]);
	});

	logger.info({ ...summary, trigger: opts.source ?? "cron" }, "topology sweep complete");
	return summary;
}

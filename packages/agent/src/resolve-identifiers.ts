// packages/agent/src/resolve-identifiers.ts
//
// SIO-1084: deterministic pre-fan-out node that resolves the loosely-named incident
// service (e.g. "order-service") into the CANONICAL identifiers that actually exist
// in each in-scope datasource, then writes them to state.resolvedIdentifiers for the
// sub-agent focus block to inject. Enumerate-then-match (never guess a prefixed form):
// each datasource has a cheap "where to look" enumerator, matched with matchesFocus.
//
// No LLM calls. Probes run in parallel with per-probe timeouts and are all non-fatal:
// any failure omits that datasource's block and the graph proceeds exactly as before.
// Default ON via RESOLVE_IDENTIFIERS_ENABLED (set =false to disable); when disabled the
// node early-returns {} (identical to today).
//
// SIO-1100/1101 (R7): before probing, seed each datasource with the service's KNOWN
// coordinates from the knowledge graph (what prior investigations confirmed via the W8
// writer). Seeds are ADDITIVE and clearly labelled "not probed this turn" in the focus
// block -- probes still run unchanged and are never skipped, so a stale seed can never
// suppress live discovery. Gated by KG_BINDINGS_READ_ENABLED (default ON) and scoped by
// KG_BINDINGS_READ_DATASOURCES (default elastic,aws).

import {
	bindingsForServices,
	getGraphStore,
	isKnowledgeGraphEnabled,
	type ServiceBinding,
} from "@devops-agent/knowledge-graph";
import { getLogger } from "@devops-agent/observability";
import { DATA_SOURCE_IDS, type ResolvedIdentifiers } from "@devops-agent/shared";
import type { RunnableConfig } from "@langchain/core/runnables";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { matchesFocus, normalize, tokenize } from "./correlation/focus-match.ts";
import { getToolsForDataSource, withAwsEstate, withElasticDeployment } from "./mcp-bridge.ts";
import {
	type CouchbaseIndexMap,
	parseAwsLogGroups,
	parseCouchbaseBuckets,
	parseCouchbaseScopeTree,
	parseCouchbaseSystemIndexes,
	parseElasticServiceAgg,
	parseGitlabProjects,
	parseKafkaConsumerGroups,
	parseKafkaTopics,
	parseKonnectControlPlanes,
	parseKonnectServices,
} from "./resolve-identifiers-parsers.ts";
import type { AgentStateType } from "./state.ts";
import { normalizeToolContent } from "./sub-agent.ts";

interface NodeLogSink {
	info: (...args: unknown[]) => unknown;
	warn: (...args: unknown[]) => unknown;
}
const defaultLogger: NodeLogSink = getLogger("agent:resolveIdentifiers") as unknown as NodeLogSink;
let currentLogger: NodeLogSink = defaultLogger;
const logger: NodeLogSink = {
	info: (...args) => currentLogger.info(...args),
	warn: (...args) => currentLogger.warn(...args),
};
export function _setResolveIdentifiersLoggerForTesting(sink: NodeLogSink | null): void {
	currentLogger = sink ?? defaultLogger;
}

// Per-probe wall-clock budget. The node runs on the hot path before fan-out, so a
// slow/unreachable MCP server must not stall the whole investigation -- but 4000ms was
// too tight: under normal proxy latency the atlassian/elastic probes timed out and the
// sub-agents lost their canonical-identifier grounding (SIO-1095). Default 8000ms, and
// make it env-tunable. Read at call time (not module scope) per the no-module-scope-env
// rule; falls back to the default on an unset/invalid value.
export const DEFAULT_PROBE_TIMEOUT_MS = 8000;
// setTimeout delays above the 32-bit signed max overflow to 1ms, which would turn a
// mis-set env value into near-instant false-negative probes (CodeRabbit). Accept only a
// positive INTEGER within that range; anything else falls back to the default.
const MAX_TIMER_DELAY_MS = 2_147_483_647;
export function probeTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
	const parsed = Number(env.RESOLVE_IDENTIFIERS_PROBE_TIMEOUT_MS);
	if (Number.isInteger(parsed) && parsed > 0 && parsed <= MAX_TIMER_DELAY_MS) return parsed;
	return DEFAULT_PROBE_TIMEOUT_MS;
}
const ELASTIC_DISCOVERY_INDEX = "logs-*,logs-apm.*";

// Default ON (same idiom as KNOWLEDGE_GRAPH_ENABLED / the KG MCP server): set
// RESOLVE_IDENTIFIERS_ENABLED=false (or 0) to turn it off.
export function isResolveIdentifiersEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	const v = env.RESOLVE_IDENTIFIERS_ENABLED;
	return v !== "false" && v !== "0";
}

// SIO-1101 (R7): graph-seed reads default ON. Set KG_BINDINGS_READ_ENABLED=false to
// disable. Also needs KNOWLEDGE_GRAPH_ENABLED (the store must exist to read from).
export function isBindingsReadEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	const v = env.KG_BINDINGS_READ_ENABLED;
	return v !== "false" && v !== "0";
}

// Which datasources accept graph seeds this turn. Default elastic,aws (the first
// cutover); widen via KG_BINDINGS_READ_DATASOURCES=elastic,aws,kafka,... without a
// code change. "all" opts every datasource in.
const DEFAULT_READ_DATASOURCES = "elastic,aws";
export function bindingsReadDatasources(env: NodeJS.ProcessEnv = process.env): Set<string> {
	const raw = env.KG_BINDINGS_READ_DATASOURCES?.trim();
	const value = raw && raw.length > 0 ? raw : DEFAULT_READ_DATASOURCES;
	return new Set(
		value
			.split(",")
			.map((s) => s.trim().toLowerCase())
			.filter((s) => s.length > 0),
	);
}

// Fixed, small budget for the graph read (a local embedded-store query, not a network
// probe -- so NOT the 8s network-probe default). Soft-fails to [] on timeout/error.
const GRAPH_SEED_TIMEOUT_MS = 1000;

// Fetch the known telemetry bindings for the focus services, scoped to the allowed
// datasources. Soft-fail: any error/timeout returns [] so the probes still run.
export async function fetchGraphSeeds(services: string[], allowed: Set<string>): Promise<ServiceBinding[]> {
	if (!isKnowledgeGraphEnabled() || !isBindingsReadEnabled()) return [];
	// Nothing this turn's in-scope datasources can accept a seed for -> skip the store
	// I/O entirely (a kafka-only turn against the default elastic,aws allowlist, etc.).
	if (allowed.size === 0) return [];
	const names = services.filter((s) => s.length > 0);
	if (names.length === 0) return [];
	try {
		const normalized = dedupe(names.map((n) => normalize(n)));
		// The 1s budget must cover getGraphStore() too: its first call runs store.init()
		// (applies the DDL) on a cold process, which is otherwise unbounded -- so the
		// "fixed 1s budget / cold start identical to pre-R7" guarantee wouldn't hold.
		const rows = await withTimeout(
			(async () => {
				const store = await getGraphStore();
				return bindingsForServices(store, names, normalized);
			})(),
			GRAPH_SEED_TIMEOUT_MS,
		);
		const wantAll = allowed.has("all");
		return rows.filter((r) => wantAll || allowed.has(r.datasource));
	} catch (err) {
		logger.warn({ error: err instanceof Error ? err.message : String(err) }, "graph-seed read failed; probing only");
		return [];
	}
}

// Mirror the supervisor's target-source resolution (supervisor.ts:41-66) so we
// probe (roughly) the datasources that will fan out this turn. We deliberately
// skip the router-mode narrowing: over-probing a datasource that the supervisor
// later drops is harmless (its probe returns nothing / it's skipped), and it
// avoids depending on the supervisor's private delegation-mode helper. UI
// selection wins; otherwise use the entity-extracted set; otherwise all.
export function computeTargetSources(state: AgentStateType): string[] {
	let targetSources = state.targetDataSources;
	if (targetSources.length === 0) {
		targetSources = state.extractedEntities.dataSources.map((d) => d.id);
	}
	if (targetSources.length === 0) targetSources = [...DATA_SOURCE_IDS];
	return [...new Set(targetSources)];
}

// From an enumerated candidate list, keep the ones related to any focus service.
// matchesFocus (token overlap + normalized substring) already bridges the plural/
// singular + prefix drift, so `order-service` matches `pvh-services-orders`. Falls
// back to a plain case-insensitive substring on the longest focus token only when
// matchesFocus finds nothing (belt for sub-4-char names it filters out).
export function pickServiceCandidates(candidates: string[], focusServices: string[]): string[] {
	if (candidates.length === 0) return [];
	const matched = candidates.filter((c) => matchesFocus(c, focusServices));
	if (matched.length > 0) return dedupe(matched);
	const tokens = focusServices.flatMap((s) => [...tokenize(s)]);
	const longest = tokens.sort((a, b) => b.length - a.length)[0];
	if (!longest) return [];
	const lower = longest.toLowerCase();
	return dedupe(candidates.filter((c) => c.toLowerCase().includes(lower)));
}

export async function resolveIdentifiers(
	state: AgentStateType,
	_config?: RunnableConfig,
): Promise<Partial<AgentStateType>> {
	// Disabled: pure no-op -- never touch state (the node effectively doesn't exist).
	if (!isResolveIdentifiersEnabled()) return {};
	// Enabled but nothing to resolve this turn: CLEAR any prior-turn resolution so a
	// stale result can't render as "probed this turn". The replace reducer only
	// overwrites on a returned key, so an empty {} would silently keep the old value
	// -- which the stamp guard would still accept when focus.services is unchanged.
	const focus = state.investigationFocus;
	if (!focus || focus.services.length === 0) return { resolvedIdentifiers: undefined };

	const inScope = new Set(computeTargetSources(state));
	// SIO-1086: the elastic probe carries a mandatory x-elastic-deployment header, and
	// @langchain/mcp-adapters forks a BRAND-NEW MCP session (full initialize handshake,
	// no header-keyed pooling) on the first invoke with a given header set. resolveIdentifiers
	// runs before fan-out, so that first forked connect happens INSIDE the timed probe and
	// blows PROBE_TIMEOUT_MS (the connect is uncancellable and has no timeout of its own),
	// even though the warm query is <1.2s. Establish the deployment-headed session OFF the
	// probe budget first, so the timed agg pays only query cost. Best-effort: the sub-agent
	// fan-out needs this exact session moments later anyway, so warming it early is free.
	if (inScope.has("elastic")) await warmElasticDeployments(state);
	// SIO-1101 (R7): fetch known coordinates from the graph BEFORE probing. Restrict to
	// in-scope AND flag-allowed datasources so we never seed something the fan-out won't
	// query this turn. Soft-fails to [] -- probes are unaffected.
	const allowedReads = bindingsReadDatasources();
	const seedScope = new Set([...inScope].filter((d) => allowedReads.has("all") || allowedReads.has(d)));
	const graphSeeds = await fetchGraphSeeds(focus.services, seedScope);

	const probes: Array<Promise<Partial<ResolvedIdentifiers>>> = [];
	if (inScope.has("elastic")) probes.push(safeProbe("elastic", () => probeElastic(state, focus.services)));
	if (inScope.has("couchbase")) probes.push(safeProbe("couchbase", () => probeCouchbase()));
	if (inScope.has("aws")) probes.push(safeProbe("aws", () => probeAws(state, focus.services)));
	if (inScope.has("kafka")) probes.push(safeProbe("kafka", () => probeKafka(focus.services)));
	if (inScope.has("konnect")) probes.push(safeProbe("konnect", () => probeKonnect(focus.services)));
	if (inScope.has("gitlab")) probes.push(safeProbe("gitlab", () => probeGitlab(focus.services)));
	// SIO-1096: no atlassian probe. Jira projects are named by team/org (DSD, BP, PANDP), never by
	// service, so a service->project name-match resolves nothing -- and the answer never needs a
	// project key: the atlassian sub-agent searches all projects by incident domain terms (its SOUL).

	// No probes AND no seeds: nothing to resolve. (Seeds alone can still produce a
	// result -- a cold service the fan-out won't probe but the graph already knows.)
	if (probes.length === 0 && graphSeeds.length === 0) return { resolvedIdentifiers: undefined };

	const settled = probes.length > 0 ? await Promise.allSettled(probes) : [];
	const merged: ResolvedIdentifiers = {
		resolvedForTurn: state.messages.length,
		resolvedForServices: focus.services,
	};
	let any = false;
	for (const s of settled) {
		if (s.status === "fulfilled" && s.value && Object.keys(s.value).length > 0) {
			Object.assign(merged, s.value);
			any = true;
		}
	}

	// SIO-1101 (R7): fold graph seeds into the per-datasource blocks AFTER the probes,
	// so probe-confirmed identifiers win. graphSeeded lists only identifiers that came
	// from the graph and were NOT independently re-found by a probe this turn.
	const graphSeeded = applyGraphSeeds(merged, graphSeeds);
	if (graphSeeded.length > 0) {
		merged.graphSeeded = graphSeeded;
		any = true;
	}

	if (!any) return { resolvedIdentifiers: undefined };

	logger.info(
		{
			resolved: Object.keys(merged).filter(
				(k) => k !== "resolvedForTurn" && k !== "resolvedForServices" && k !== "graphSeeded",
			),
			graphSeededCount: graphSeeded.length,
			focusServices: focus.services,
		},
		"resolveIdentifiers produced candidates",
	);
	return { resolvedIdentifiers: merged };
}

// Max graph-only identifiers to add per datasource: keeps the checkpointer payload
// bounded and the focus block short (a stale binding should never dominate).
const MAX_GRAPH_SEEDS_PER_DATASOURCE = 5;

// SIO-1101 (R7): fold ServiceBinding[] into the ResolvedIdentifiers per-datasource
// blocks. Only adds identifiers NOT already present (probe results win), caps per
// datasource, and returns the flat list of identifiers that were graph-only this turn
// (used by the focus block to label them "not probed this turn"). Stage 2 handles the
// array-shaped blocks (elastic/aws/kafka); scalar konnect/gitlab ids are left to a
// later stage.
export function applyGraphSeeds(merged: ResolvedIdentifiers, seeds: ServiceBinding[]): string[] {
	const graphSeeded: string[] = [];
	const perDatasourceCount = new Map<string, number>();

	const addTo = (list: string[], value: string, datasource: string): void => {
		if (!value) return;
		const used = perDatasourceCount.get(datasource) ?? 0;
		if (used >= MAX_GRAPH_SEEDS_PER_DATASOURCE) return;
		// Probe result already has it (case-insensitive) -> probe-confirmed, not a seed.
		if (list.some((v) => v.toLowerCase() === value.toLowerCase())) return;
		list.push(value);
		perDatasourceCount.set(datasource, used + 1);
		graphSeeded.push(value);
	};

	for (const s of seeds) {
		switch (s.kind) {
			case "serviceName": {
				merged.elastic ??= { serviceNames: [] };
				addTo(merged.elastic.serviceNames, s.resourceId, "elastic");
				break;
			}
			case "logGroup": {
				merged.aws ??= { logGroups: [] };
				addTo(merged.aws.logGroups, s.resourceId, "aws");
				break;
			}
			case "ecsService": {
				merged.aws ??= { logGroups: [] };
				merged.aws.ecsServices ??= [];
				addTo(merged.aws.ecsServices, s.resourceId, "aws");
				break;
			}
			case "topic": {
				merged.kafka ??= { topics: [], consumerGroups: [] };
				addTo(merged.kafka.topics, s.resourceId, "kafka");
				break;
			}
			case "consumerGroup": {
				merged.kafka ??= { topics: [], consumerGroups: [] };
				addTo(merged.kafka.consumerGroups, s.resourceId, "kafka");
				break;
			}
			// konnect/gitlab scalars: deferred (Stage 2 seeds the array-shaped blocks).
			default:
				break;
		}
	}
	return graphSeeded;
}

async function safeProbe(
	dataSourceId: string,
	fn: () => Promise<Partial<ResolvedIdentifiers>>,
): Promise<Partial<ResolvedIdentifiers>> {
	try {
		return await withTimeout(fn(), probeTimeoutMs());
	} catch (err) {
		logger.warn(
			{ dataSourceId, error: err instanceof Error ? err.message : String(err) },
			"resolveIdentifiers probe failed; omitting this datasource",
		);
		return {};
	}
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<T>((_resolve, reject) => {
		timer = setTimeout(() => reject(new Error(`probe timed out after ${ms}ms`)), ms);
		timer.unref?.();
	});
	// Clear the timer once the race settles either way, so a resolved probe leaves no
	// dangling timer (and no late reject() on an already-settled branch).
	return Promise.race([p, timeout]).finally(() => {
		if (timer) clearTimeout(timer);
	});
}

function toolFor(dataSourceId: string, name: string): StructuredToolInterface | undefined {
	return getToolsForDataSource(dataSourceId).find((t) => t.name === name);
}

// SIO-1086: wall-clock bound for the off-budget warm-up. Generous enough to cover a
// cold MCP fork/connect + initialize handshake (which has no timeout of its own), but
// still bounded so a genuinely-unreachable elastic server can't stall the pipeline. This
// is SEPARATE from PROBE_TIMEOUT_MS: the warm-up pays the connect cost so the timed probe
// that follows only pays query cost.
const ELASTIC_WARMUP_TIMEOUT_MS = 8000;

// SIO-1086: open the deployment-headed MCP session(s) BEFORE the timed probe races the
// PROBE_TIMEOUT_MS clock, so the uncancellable cold fork/connect happens off-budget.
// A `size:0` + `terminate_after:1` match_all is the cheapest call that still forces the
// header-fork/connect. Best-effort and fully swallowed: a warm-up failure just means the
// timed probe pays the connect cost as before -- never worse than today.
async function warmElasticDeployments(state: AgentStateType): Promise<void> {
	const tool = toolFor("elastic", "elasticsearch_search");
	if (!tool) return;
	const deployments = state.targetDeployments.length > 0 ? state.targetDeployments : [undefined];
	const warmArgs = { index: ELASTIC_DISCOVERY_INDEX, size: 0, terminate_after: 1, query: { match_all: {} } };
	await Promise.allSettled(
		deployments.map((deploymentId) => {
			const invoke = () =>
				deploymentId ? withElasticDeployment(deploymentId, () => tool.invoke(warmArgs)) : tool.invoke(warmArgs);
			return withTimeout(invoke(), ELASTIC_WARMUP_TIMEOUT_MS).catch((err) => {
				logger.warn({ deploymentId, error: msg(err) }, "elastic session warm-up failed (probe will pay connect cost)");
			});
		}),
	);
}

async function probeElastic(state: AgentStateType, focusServices: string[]): Promise<Partial<ResolvedIdentifiers>> {
	const tool = toolFor("elastic", "elasticsearch_search");
	if (!tool) return {};
	const deployments = state.targetDeployments.length > 0 ? state.targetDeployments : [undefined];
	// SIO-1086: FILTER the discovery agg to the anchor tokens (a wildcard per token)
	// BEFORE aggregating, instead of a global top-N terms agg. A plain
	// `terms{size:50}` over the whole cluster ranks by document volume, so a
	// low-volume service (e.g. `prana-order-service`) falls outside the top buckets
	// and is wrongly reported absent. Filtering to `*<token>*` first makes the agg
	// exhaustive for every name matching the anchor regardless of volume; the larger
	// terms size is then just a safety bound. Verified live: the filtered agg surfaces
	// prana-order-service (+ 11 other *order* services) that the top-50 dropped.
	const shoulds = anchorWildcards(focusServices);
	const query = shoulds.length > 0 ? { bool: { should: shoulds, minimum_should_match: 1 } } : { match_all: {} };
	const args = {
		index: ELASTIC_DISCOVERY_INDEX,
		size: 0,
		query,
		aggs: { by_service: { terms: { field: "service.name", size: 200 } } },
	};
	// Probe deployments in PARALLEL: they share one PROBE_TIMEOUT_MS budget, so a
	// sequential loop would compound latency and time the whole probe out (dropping
	// every partial result) on multi-deployment setups.
	const settled = await Promise.allSettled(
		deployments.map((deploymentId) =>
			deploymentId ? withElasticDeployment(deploymentId, () => tool.invoke(args)) : tool.invoke(args),
		),
	);
	const all: string[] = [];
	settled.forEach((r, i) => {
		if (r.status === "fulfilled") {
			all.push(...parseElasticServiceAgg(normalizeToolContent(r.value)));
		} else {
			logger.warn(
				{ deploymentId: deployments[i], error: msg(r.reason) },
				"elastic discovery probe failed for deployment",
			);
		}
	});
	const serviceNames = pickServiceCandidates(all, focusServices);
	return serviceNames.length > 0 ? { elastic: { serviceNames } } : {};
}

// SIO-1107: bound the bucket-aware second hop -- how many non-default buckets get a
// per-bucket scopes/collections probe, and how many bucket names land in state.
const MAX_PROBED_BUCKETS = 3;
const MAX_BUCKET_NAMES = 10;

async function probeCouchbase(): Promise<Partial<ResolvedIdentifiers>> {
	const scopesTool = toolFor("couchbase", "capella_get_scopes_and_collections");
	if (!scopesTool) return {};
	// SIO-1087: probe scopes AND indexes together (Promise.allSettled so an index-probe failure
	// never blocks the scope map). The index probe tells us which collections are actually
	// queryable, so the focus block can steer the agent away from SELECT *-ing index-less
	// collections (the seasons.* planning-failure storm).
	// SIO-1107: bucket enumeration joins the same parallel round. The tool is absent on older
	// servers -- then every new field stays undefined and the result is identical to before.
	const indexesTool = toolFor("couchbase", "capella_get_system_indexes");
	const bucketsTool = toolFor("couchbase", "capella_get_buckets");
	const [scopesRes, indexesRes, bucketsRes] = await Promise.allSettled([
		scopesTool.invoke({}),
		indexesTool ? indexesTool.invoke({}) : Promise.reject(new Error("capella_get_system_indexes unavailable")),
		bucketsTool ? bucketsTool.invoke({}) : Promise.reject(new Error("capella_get_buckets unavailable")),
	]);
	if (scopesRes.status !== "fulfilled") return {};
	const scopes = parseCouchbaseScopeTree(normalizeToolContent(scopesRes.value));
	if (Object.keys(scopes).length === 0) return {};

	let defaultBucket: string | undefined;
	let bucketNames: string[] | undefined;
	if (bucketsRes.status === "fulfilled") {
		const parsedBuckets = parseCouchbaseBuckets(normalizeToolContent(bucketsRes.value));
		if (parsedBuckets.buckets.length > 0) {
			defaultBucket = parsedBuckets.defaultBucket;
			bucketNames = parsedBuckets.buckets.slice(0, MAX_BUCKET_NAMES);
		}
	} else {
		logger.warn({ error: msg(bucketsRes.reason) }, "couchbase bucket probe unavailable; resolving default bucket only");
	}

	// Inject the ENTIRE scope map -- enumerating what exists is the fix; do not filter.
	// SIO-1088: capture per-collection primary/secondary index info so the focus block can steer the
	// agent to the RIGHT query shape (SELECT * only where a primary index exists; WHERE-on-key-field
	// elsewhere). Key off the probe SUCCEEDING (an empty-but-present map correctly marks every
	// collection secondary-less; a failed probe stays undefined -> renderer omits the tag).
	let indexInfo: CouchbaseIndexMap | undefined;
	if (indexesRes.status === "fulfilled") {
		const rawIndexes = normalizeToolContent(indexesRes.value);
		// SIO-1107: system:indexes is cluster-wide; scope the map to the default bucket when known
		// so another bucket's indexes never tag the default bucket's collections.
		indexInfo = parseCouchbaseSystemIndexes(rawIndexes, defaultBucket);
		// SIO-1088 (CodeRabbit): distinguish a GENUINE "no online indexes" response from PARSE DRIFT
		// (the upstream shape changed and the parser silently extracted nothing). Both collapse to an
		// empty map otherwise, which would mislabel every collection [NO USABLE INDEX]. If the raw
		// payload plainly contained index rows (keyspace_id/scope_id keys) but we extracted zero,
		// that's drift -- warn AND omit the tags (undefined) rather than asserting "no index".
		if (Object.keys(indexInfo).length === 0 && /"(?:keyspace_id|scope_id)"\s*:/.test(rawIndexes)) {
			logger.warn(
				{ rawSample: rawIndexes.slice(0, 200) },
				"couchbase index probe returned rows but parser extracted none (shape drift?); omitting index tags",
			);
			indexInfo = undefined;
		}
	} else {
		logger.warn(
			{ error: msg(indexesRes.reason) },
			"couchbase index probe failed; collections rendered without index tags",
		);
	}

	// SIO-1107: bounded second hop -- enumerate scopes/collections of up to MAX_PROBED_BUCKETS
	// non-default buckets in parallel. Per-bucket failures are non-fatal; the whole hop shares
	// the node's existing probe budget (these are fast collection-manager reads).
	let otherBucketScopes: Record<string, Record<string, string[]>> | undefined;
	if (defaultBucket && bucketNames) {
		const others = bucketNames.filter((b) => b !== defaultBucket).slice(0, MAX_PROBED_BUCKETS);
		if (others.length > 0) {
			const settled = await Promise.allSettled(others.map((b) => scopesTool.invoke({ bucket_name: b })));
			settled.forEach((res, i) => {
				const name = others[i];
				if (!name) return;
				if (res.status !== "fulfilled") {
					logger.warn({ bucket: name, error: msg(res.reason) }, "couchbase per-bucket scope probe failed");
					return;
				}
				const tree = parseCouchbaseScopeTree(normalizeToolContent(res.value));
				if (Object.keys(tree).length === 0) return;
				otherBucketScopes = otherBucketScopes ?? {};
				otherBucketScopes[name] = tree;
			});
		}
	}

	const couchbase: NonNullable<ResolvedIdentifiers["couchbase"]> = { scopes };
	if (indexInfo) couchbase.indexInfo = indexInfo;
	if (defaultBucket) couchbase.defaultBucket = defaultBucket;
	if (bucketNames) couchbase.buckets = bucketNames;
	if (otherBucketScopes) couchbase.otherBucketScopes = otherBucketScopes;
	return { couchbase };
}

async function probeAws(state: AgentStateType, focusServices: string[]): Promise<Partial<ResolvedIdentifiers>> {
	// AWS tools REQUIRE an estate (injected from the withAwsEstate ALS scope); with
	// no target estate there is nothing to probe -- invoking outside the scope would
	// throw. (Unlike elastic, which has a default deployment.) Skip cleanly.
	if (state.awsTargetEstates.length === 0) return {};
	const describe = toolFor("aws", "aws_logs_describe_log_groups");
	if (!describe) return {};
	const pattern = longestToken(focusServices);
	if (!pattern) return {};
	// Log-group discovery only. ECS-service enumeration is intentionally NOT probed
	// here: aws_ecs_list_services requires a `cluster` arg (a prior list-clusters
	// hop), too heavy for a cheap pre-fan-out probe -- the aws-agent RULES.md
	// (SIO-1084) drives the ECS -> awslogs-group derivation on the sub-agent side.
	// Probe estates in PARALLEL (they share one PROBE_TIMEOUT_MS budget, so a
	// sequential loop would compound latency across estates).
	const estates = state.awsTargetEstates;
	const settled = await Promise.allSettled(
		estates.map((estate) => withAwsEstate(estate, () => describe.invoke({ logGroupNamePattern: pattern, limit: 50 }))),
	);
	const logGroups: string[] = [];
	settled.forEach((r, i) => {
		if (r.status === "fulfilled") {
			const parsed = parseAwsLogGroups(safeJson(normalizeToolContent(r.value)));
			logGroups.push(...parsed.logGroups.filter((n) => matchesFocus(n, focusServices)));
		} else {
			logger.warn({ estate: estates[i], error: msg(r.reason) }, "aws log-group probe failed for estate");
		}
	});
	return logGroups.length > 0 ? { aws: { logGroups: dedupe(logGroups) } } : {};
}

async function probeKafka(focusServices: string[]): Promise<Partial<ResolvedIdentifiers>> {
	const topicsTool = toolFor("kafka", "kafka_list_topics");
	const groupsTool = toolFor("kafka", "kafka_list_consumer_groups");
	const topics: string[] = [];
	const consumerGroups: string[] = [];
	// DO NOT pass `filter` -- the server compiles it as a raw RegExp and a non-regex
	// token throws MCP -32603. Enumerate unfiltered and match client-side.
	if (topicsTool) {
		try {
			const raw = await topicsTool.invoke({ limit: 500 });
			const all = parseKafkaTopics(safeJson(normalizeToolContent(raw)));
			topics.push(...all.filter((n) => matchesFocus(n, focusServices)));
		} catch (err) {
			logger.warn({ error: msg(err) }, "kafka topic probe failed");
		}
	}
	if (groupsTool) {
		try {
			const raw = await groupsTool.invoke({});
			const all = parseKafkaConsumerGroups(safeJson(normalizeToolContent(raw)));
			consumerGroups.push(...all.filter((n) => matchesFocus(n, focusServices)));
		} catch (err) {
			logger.warn({ error: msg(err) }, "kafka consumer-group probe failed");
		}
	}
	return topics.length > 0 || consumerGroups.length > 0
		? { kafka: { topics: dedupe(topics), consumerGroups: dedupe(consumerGroups) } }
		: {};
}

async function probeKonnect(focusServices: string[]): Promise<Partial<ResolvedIdentifiers>> {
	const cpTool = toolFor("konnect", "konnect_list_control_planes");
	if (!cpTool) return {};
	const pattern = longestToken(focusServices);
	const cpArgs = pattern ? { filterName: pattern, pageSize: 10 } : { pageSize: 10 };
	const cps = parseKonnectControlPlanes(safeJson(normalizeToolContent(await cpTool.invoke(cpArgs))));
	// Pick the control plane whose name matches the focus, else the first.
	const cp = cps.find((c) => c.name && matchesFocus(c.name, focusServices)) ?? cps[0];
	if (!cp) return {};
	const result: NonNullable<ResolvedIdentifiers["konnect"]> = {
		controlPlaneId: cp.controlPlaneId,
		controlPlaneName: cp.name,
	};
	const svcTool = toolFor("konnect", "konnect_list_services");
	if (svcTool) {
		try {
			const raw = await svcTool.invoke({ controlPlaneId: cp.controlPlaneId, pageSize: 100 });
			const services = parseKonnectServices(safeJson(normalizeToolContent(raw)));
			const matched = services.filter((s) => s.name && matchesFocus(s.name, focusServices)).map((s) => s.serviceId);
			if (matched.length > 0) result.serviceIds = dedupe(matched);
		} catch (err) {
			logger.warn({ error: msg(err) }, "konnect service probe failed");
		}
	}
	return { konnect: result };
}

async function probeGitlab(focusServices: string[]): Promise<Partial<ResolvedIdentifiers>> {
	const tool = toolFor("gitlab", "gitlab_search");
	if (!tool) return {};
	const term = longestToken(focusServices) ?? focusServices[0];
	if (!term) return {};
	const rows = parseGitlabProjects(
		safeJson(normalizeToolContent(await tool.invoke({ scope: "projects", search: term }))),
	);
	// Match on name/path, then lift the numeric id (guessing the path 404s).
	const match = rows.find((r) => matchesFocus(r.pathWithNamespace ?? r.name ?? "", focusServices)) ?? rows[0];
	if (!match) return {};
	return { gitlab: { projectId: match.id, pathWithNamespace: match.pathWithNamespace } };
}

function longestToken(focusServices: string[]): string | undefined {
	const tokens = focusServices.flatMap((s) => [...tokenize(s)]);
	return tokens.sort((a, b) => b.length - a.length)[0];
}

// SIO-1086: build a `wildcard` clause per anchor token so the elastic discovery agg
// can filter to matching service names before aggregating. tokenize() already drops
// sub-4-char noise and depluralizes, so these are meaningful anchors (e.g.
// "order-service" -> ["order"] -> {wildcard:{service.name:"*order*"}}). Deduped and
// bounded so a many-token focus can't explode the query.
function anchorWildcards(focusServices: string[]): Array<{ wildcard: { "service.name": { value: string } } }> {
	const tokens = dedupe(focusServices.flatMap((s) => [...tokenize(s)])).slice(0, 8);
	return tokens.map((t) => ({ wildcard: { "service.name": { value: `*${t}*` } } }));
}

function safeJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}

function dedupe(items: string[]): string[] {
	return [...new Set(items)];
}

function msg(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

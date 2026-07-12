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
// Gated OFF by default via RESOLVE_IDENTIFIERS_ENABLED so enabling it is a deliberate
// rollout step; when disabled the node early-returns {} (identical to today).

import { getLogger } from "@devops-agent/observability";
import { DATA_SOURCE_IDS, type ResolvedIdentifiers } from "@devops-agent/shared";
import type { RunnableConfig } from "@langchain/core/runnables";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { matchesFocus, tokenize } from "./correlation/focus-match.ts";
import { getToolsForDataSource, withAwsEstate, withElasticDeployment } from "./mcp-bridge.ts";
import {
	parseAtlassianProjects,
	parseAtlassianSpaces,
	parseAwsLogGroups,
	parseCouchbaseScopeTree,
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

// Per-probe wall-clock budget. Kept small: the node runs on the hot path before
// fan-out, so a slow/unreachable MCP server must not stall the whole investigation.
const PROBE_TIMEOUT_MS = 4000;
const ELASTIC_DISCOVERY_INDEX = "logs-*,logs-apm.*";

export function isResolveIdentifiersEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	const v = env.RESOLVE_IDENTIFIERS_ENABLED;
	return v === "true" || v === "1";
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
	const probes: Array<Promise<Partial<ResolvedIdentifiers>>> = [];
	if (inScope.has("elastic")) probes.push(safeProbe("elastic", () => probeElastic(state, focus.services)));
	if (inScope.has("couchbase")) probes.push(safeProbe("couchbase", () => probeCouchbase()));
	if (inScope.has("aws")) probes.push(safeProbe("aws", () => probeAws(state, focus.services)));
	if (inScope.has("kafka")) probes.push(safeProbe("kafka", () => probeKafka(focus.services)));
	if (inScope.has("konnect")) probes.push(safeProbe("konnect", () => probeKonnect(focus.services)));
	if (inScope.has("gitlab")) probes.push(safeProbe("gitlab", () => probeGitlab(focus.services)));
	if (inScope.has("atlassian")) probes.push(safeProbe("atlassian", () => probeAtlassian(focus.services)));

	if (probes.length === 0) return { resolvedIdentifiers: undefined };

	const settled = await Promise.allSettled(probes);
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
	if (!any) return { resolvedIdentifiers: undefined };

	logger.info(
		{
			resolved: Object.keys(merged).filter((k) => k !== "resolvedForTurn" && k !== "resolvedForServices"),
			focusServices: focus.services,
		},
		"resolveIdentifiers produced candidates",
	);
	return { resolvedIdentifiers: merged };
}

async function safeProbe(
	dataSourceId: string,
	fn: () => Promise<Partial<ResolvedIdentifiers>>,
): Promise<Partial<ResolvedIdentifiers>> {
	try {
		return await withTimeout(fn(), PROBE_TIMEOUT_MS);
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

async function probeCouchbase(): Promise<Partial<ResolvedIdentifiers>> {
	const tool = toolFor("couchbase", "capella_get_scopes_and_collections");
	if (!tool) return {};
	const raw = await tool.invoke({});
	const scopes = parseCouchbaseScopeTree(normalizeToolContent(raw));
	// Inject the ENTIRE map -- enumerating what exists is the fix; do not filter.
	return Object.keys(scopes).length > 0 ? { couchbase: { scopes } } : {};
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

async function probeAtlassian(focusServices: string[]): Promise<Partial<ResolvedIdentifiers>> {
	const projectsTool = toolFor("atlassian", "atlassian_getVisibleJiraProjects");
	const spacesTool = toolFor("atlassian", "atlassian_getConfluenceSpaces");
	const jiraProjectKeys: string[] = [];
	const confluenceSpaceKeys: string[] = [];
	if (projectsTool) {
		try {
			const rows = parseAtlassianProjects(safeJson(normalizeToolContent(await projectsTool.invoke({}))));
			jiraProjectKeys.push(
				...rows.filter((r) => matchesFocus(`${r.key} ${r.name ?? ""}`, focusServices)).map((r) => r.key),
			);
		} catch (err) {
			logger.warn({ error: msg(err) }, "atlassian jira-project probe failed");
		}
	}
	if (spacesTool) {
		try {
			const rows = parseAtlassianSpaces(safeJson(normalizeToolContent(await spacesTool.invoke({}))));
			confluenceSpaceKeys.push(
				...rows.filter((r) => matchesFocus(`${r.key} ${r.name ?? ""}`, focusServices)).map((r) => r.key),
			);
		} catch (err) {
			logger.warn({ error: msg(err) }, "atlassian confluence-space probe failed");
		}
	}
	return jiraProjectKeys.length > 0 || confluenceSpaceKeys.length > 0
		? { atlassian: { jiraProjectKeys: dedupe(jiraProjectKeys), confluenceSpaceKeys: dedupe(confluenceSpaceKeys) } }
		: {};
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

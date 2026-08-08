// agent/src/record-bindings.ts
//
// SIO-1100: the W8 investigation-learnings writer. At the end of a turn it derives
// the telemetry bindings the fan-out actually used successfully -- the intersection
// of resolveIdentifiers' per-datasource canonical identifiers (SIO-1084) and the
// datasources that produced findings without a degrading error (SIO-1087) -- and
// MERGEs them into the knowledge graph, plus a durable Couchbase fact when the
// agent-memory backend is on. Deterministic, no LLM, no new probes. Runs whenever
// KNOWLEDGE_GRAPH_ENABLED is set (KG_BINDINGS_WRITE_ENABLED defaults ON; set it to
// false to disable). Writes are additive + soft-failing, so enabling it never
// changes the investigation's answer -- only what the graph learns for next time.

import {
	type BindingKind,
	bindingsForServices,
	flagBindingForReview,
	type GraphStore,
	getGraphStore,
	hasBinding,
	invalidateBinding,
	isKnowledgeGraphEnabled,
	recordAppMapTopologyEdges,
	recordNetworkTopology,
	recordServiceBinding,
	type ServiceBinding,
	type ServiceBindingRecord,
} from "@devops-agent/knowledge-graph";
import { getLogger } from "@devops-agent/observability";
import { type DataSourceResult, isDegradingCategory, type ResolvedIdentifiers } from "@devops-agent/shared";
import { deriveApplicationTopology } from "./application-topology-kg.ts";
import { normalize } from "./correlation/focus-match.ts";
import { recordKeyDecision } from "./memory-writer.ts";
import { deriveNetworkTopology } from "./network-kg.ts";
import type { AgentStateType } from "./state.ts";

const logger = getLogger("agent:record-bindings");

// Agent-inferred confidence (human-confirmed is 1.0, Stage 4). Provenance string.
const AGENT_CONFIDENCE = 0.7;
const DISCOVERED_BY = "resolve-identifiers";

// Default ON (same idiom as KNOWLEDGE_GRAPH_ENABLED): set
// KG_BINDINGS_WRITE_ENABLED=false (or 0) to turn the writer off. The node still
// requires KNOWLEDGE_GRAPH_ENABLED and produces bindings only when
// resolveIdentifiers ran, so with the graph off it stays inert regardless.
export function isBindingsWriteEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	const v = env.KG_BINDINGS_WRITE_ENABLED;
	return v !== "false" && v !== "0";
}

// SIO-1103: the staleness lifecycle (auto-invalidation of dead agent bindings) is
// gated separately so it can be disabled without turning off the writer. Default ON;
// set KG_BINDINGS_STALENESS_ENABLED=false to disable.
export function isStalenessEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	const v = env.KG_BINDINGS_STALENESS_ENABLED;
	return v !== "false" && v !== "0";
}

// SIO-1204: the network-topology persistence gate (same default-ON idiom). Inert
// without KNOWLEDGE_GRAPH_ENABLED (the node-level master gate below), and inert
// when the turn produced no state.networkTopology.
export function isNetworkWriteEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	const v = env.KG_NETWORK_WRITE_ENABLED;
	return v !== "false" && v !== "0";
}

// SIO-1457: the application-map persistence gate (same default-ON idiom). Inert
// without KNOWLEDGE_GRAPH_ENABLED, and inert when the turn produced no
// state.applicationTopology or the map carried only prior-knowledge edges.
export function isAppMapWriteEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	const v = env.KG_APP_MAP_WRITE_ENABLED;
	return v !== "false" && v !== "0";
}

// Case-insensitive set equality (mirrors sub-agent-focus-block's stamp guard): a
// resolution answers a specific focus.services snapshot, so a stale prior-turn
// resolution must never seed bindings for a different service set.
function sameServiceSet(a: string[], b: string[]): boolean {
	const setA = new Set(a.map((s) => s.toLowerCase()));
	const setB = new Set(b.map((s) => s.toLowerCase()));
	if (setA.size !== setB.size) return false;
	for (const s of setA) if (!setB.has(s)) return false;
	return true;
}

// A datasource "confirmed useful" this turn: it succeeded AND carried no degrading
// error. SIO-1087's isDegradingCategory excludes no-data/not-found (routine discovery
// outcomes) so an empty-but-correct scope still confirms its identifier; only a real
// malfunction (auth/server/bad-query) blocks confirmation.
function datasourceConfirmed(result: DataSourceResult | undefined): boolean {
	if (result?.status !== "success") return false;
	return (result.toolErrors ?? []).every((e) => !isDegradingCategory(e.category));
}

// SIO-1102: was this specific identifier actually USED by the datasource this turn?
// toolOutputs capture each tool call's parsed output (`rawJson`, not input args -- the
// state shape carries no args), so a resolved coordinate that the fan-out genuinely
// queried is echoed in (or returned by) at least one tool output. This is the
// identifier-level tightening of Stage 1's datasource-level "had findings" heuristic:
// an identifier the probe resolved but the sub-agent never touched is NOT confirmed.
// Returns `null` (not false) when there are no tool outputs to judge against, so the
// caller can fall back to the datasource-level signal rather than dropping everything.
//
// The match is IDENTIFIER-BOUNDARY-aware, not a raw substring (SIO-1102 CodeRabbit): a
// short id like `orders` must NOT be confirmed by `orders-api` or `reorders-worker`.
// Identifiers can themselves contain `-`, `_`, `.`, `/` (e.g. `/ecs/orders-prd`), so
// the boundary chars that DELIMIT one identifier from another are exactly those NOT in
// that set plus alphanumerics -- i.e. JSON/whitespace punctuation. We require the match
// to be preceded and followed by such a delimiter (or the string edge).
const ID_CHAR = /[a-z0-9._/-]/;

function boundaryMatch(haystack: string, needle: string): boolean {
	let from = 0;
	for (;;) {
		const at = haystack.indexOf(needle, from);
		if (at === -1) return false;
		const before = at === 0 ? "" : (haystack[at - 1] ?? "");
		const afterIdx = at + needle.length;
		const after = afterIdx >= haystack.length ? "" : (haystack[afterIdx] ?? "");
		if (!ID_CHAR.test(before) && !ID_CHAR.test(after)) return true;
		from = at + 1;
	}
}

export function identifierUsedInToolCalls(identifier: string, result: DataSourceResult | undefined): boolean | null {
	if (!identifier) return false;
	const outputs = result?.toolOutputs ?? [];
	if (outputs.length === 0) return null;
	const needle = identifier.toLowerCase();
	for (const o of outputs) {
		const hay = (typeof o.rawJson === "string" ? o.rawJson : JSON.stringify(o.rawJson ?? "")).toLowerCase();
		if (boundaryMatch(hay, needle)) return true;
	}
	return false;
}

// The per-datasource identifier -> binding-kind/resource mapping. Couchbase is
// skipped in Stage 1 (its scopes/indexInfo describe org structure, not a per-service
// binding); atlassian has no field (SIO-1096 removed the probe).
interface RawBinding {
	datasource: string;
	kind: BindingKind;
	resourceId: string;
	locator?: string;
}

function rawBindingsFor(resolved: ResolvedIdentifiers): RawBinding[] {
	const out: RawBinding[] = [];
	// SIO-1276: carry the DEPLOYMENT in the locator. Without it the graph learns
	// "order-service -> prana-order-service" but not WHERE that name lives, so a seeded
	// binding cannot answer the question SIO-1279 exists to answer -- which of the 10
	// configured clusters to query. The locator field already carries exactly this kind of
	// qualifier for konnect (controlPlaneName) and gitlab (pathWithNamespace); elastic was
	// the one datasource passing none, so the deployment resolveIdentifiers now discovers
	// was being discarded on write.
	//
	// Placements are keyed by serviceName, so look up each name's deployment rather than
	// assuming one cluster: the same service name CAN exist in more than one deployment,
	// and recording it against the wrong one is worse than recording nothing.
	//
	// CodeRabbit on PR #524: an earlier version kept the FIRST placement per name, which
	// contradicted that reasoning -- on an ambiguous name it persisted whichever cluster
	// the fan-out happened to return first, and a seeded wrong deployment is worse than no
	// deployment (the sub-agent would scope confidently to the wrong cluster instead of
	// falling back to discovery). Collect the DISTINCT deployments per name and only write
	// a locator when exactly one survives; ambiguity records the alias without a locator.
	//
	// "(default)" is the probe's label for an unset ELASTIC_DEPLOYMENTS. It is not a real
	// deployment id, so it is filtered out BEFORE the uniqueness check -- otherwise a
	// single-cluster install would look "ambiguous" and lose a locator it never had.
	const deploymentsByName = new Map<string, Set<string>>();
	for (const p of resolved.elastic?.placements ?? []) {
		if (!p.deployment || p.deployment === "(default)") continue;
		const set = deploymentsByName.get(p.serviceName) ?? new Set<string>();
		set.add(p.deployment);
		deploymentsByName.set(p.serviceName, set);
	}
	for (const name of resolved.elastic?.serviceNames ?? []) {
		const candidates = deploymentsByName.get(name);
		const unambiguous = candidates?.size === 1 ? [...candidates][0] : undefined;
		if (candidates && candidates.size > 1) {
			logger.info(
				{ serviceName: name, deployments: [...candidates] },
				"elastic name found in multiple deployments; recording binding without a deployment locator",
			);
		}
		out.push({
			datasource: "elastic",
			kind: "serviceName",
			resourceId: name,
			...(unambiguous && { locator: unambiguous }),
		});
	}
	for (const lg of resolved.aws?.logGroups ?? []) {
		out.push({ datasource: "aws", kind: "logGroup", resourceId: lg });
	}
	for (const svc of resolved.aws?.ecsServices ?? []) {
		out.push({ datasource: "aws", kind: "ecsService", resourceId: svc });
	}
	for (const topic of resolved.kafka?.topics ?? []) {
		out.push({ datasource: "kafka", kind: "topic", resourceId: topic });
	}
	for (const cg of resolved.kafka?.consumerGroups ?? []) {
		out.push({ datasource: "kafka", kind: "consumerGroup", resourceId: cg });
	}
	const cp = resolved.konnect?.controlPlaneId;
	if (cp) {
		out.push({
			datasource: "konnect",
			kind: "konnectControlPlane",
			resourceId: cp,
			locator: resolved.konnect?.controlPlaneName,
		});
	}
	for (const sid of resolved.konnect?.serviceIds ?? []) {
		out.push({ datasource: "konnect", kind: "konnectService", resourceId: sid });
	}
	const proj = resolved.gitlab?.projectId ?? resolved.gitlab?.pathWithNamespace;
	if (proj) {
		out.push({
			datasource: "gitlab",
			kind: "gitlabProject",
			resourceId: proj,
			locator: resolved.gitlab?.pathWithNamespace,
		});
	}
	return out;
}

// Pure: derive the confirmed telemetry bindings for this turn. Empty when there is
// no fresh resolution, no focus, or nothing was confirmed -- so the node self-skips
// its writes without touching the store.
export function deriveConfirmedBindings(state: AgentStateType): ServiceBindingRecord[] {
	const resolved = state.resolvedIdentifiers;
	const focus = state.investigationFocus;
	if (!resolved || !focus || focus.services.length === 0) return [];
	// Stamp guard: the resolution must answer the current focus (SIO-1084).
	if (!sameServiceSet(resolved.resolvedForServices, focus.services)) return [];

	const resultsById = new Map<string, DataSourceResult>();
	for (const r of state.dataSourceResults ?? []) resultsById.set(r.dataSourceId, r);

	// Stage 1 attributes every confirmed binding to the single focus service when
	// there is exactly one (the common incident shape); multi-service focuses do not
	// attribute per-datasource identifiers to a specific service yet (Stage 3
	// identifier-in-tool-args tightening), so they are skipped to avoid mis-binding.
	const service = focus.services.length === 1 ? focus.services[0] : undefined;
	if (!service) return [];
	const serviceNormalized = normalize(service);

	const records: ServiceBindingRecord[] = [];
	for (const raw of rawBindingsFor(resolved)) {
		if (!raw.resourceId) continue;
		const result = resultsById.get(raw.datasource);
		if (!datasourceConfirmed(result)) continue;
		// SIO-1102: identifier-level tightening. The datasource succeeded; now require
		// that THIS identifier was actually used (appears in a tool output). null =
		// no tool outputs to judge against -> fall back to the datasource-level signal
		// (which datasourceConfirmed already satisfied) rather than dropping it.
		const used = identifierUsedInToolCalls(raw.resourceId, result);
		if (used === false) continue;
		records.push({
			service,
			serviceNormalized,
			// The raw focus token. recordServiceBinding writes an Alias/RESOLVES_TO edge
			// only when this differs from the canonical service; today the incident
			// keys Service on the focus token so they match (no alias), but threading it
			// keeps the alias-hop reader path reachable once a resolver surfaces a raw
			// name distinct from the canonical service (Stage 2+).
			aliasRaw: service,
			datasource: raw.datasource,
			kind: raw.kind,
			resourceId: raw.resourceId,
			locator: raw.locator ?? "",
			confidence: AGENT_CONFIDENCE,
			discoveredBy: DISCOVERED_BY,
			evidence: `confirmed:${raw.datasource}`,
			incidentId: state.requestId,
		});
	}
	return records;
}

// SIO-1103: which datasources reported a `not-found` this turn -- the unambiguous
// "this coordinate no longer exists" signal (an index/log-group/topic that was named
// but is gone). We deliberately do NOT treat `no-data` (empty-but-valid scope) as
// staleness: a chronic error can be quiet, and invalidating on emptiness would churn
// good bindings. Returns the set of datasource ids.
function datasourcesReportingNotFound(state: AgentStateType): Set<string> {
	const out = new Set<string>();
	for (const r of state.dataSourceResults ?? []) {
		if ((r.toolErrors ?? []).some((e) => e.category === "not-found")) out.add(r.dataSourceId);
	}
	return out;
}

// SIO-1103: staleness lifecycle. A graph-SEEDED identifier (injected this turn from a
// prior investigation's binding, per resolvedIdentifiers.graphSeeded) whose datasource
// reported `not-found` is a dead-binding candidate. Look up the stored binding to read
// its discoveredBy, then: agent-discovered -> invalidateBinding (retire it); human ->
// flagBindingForReview (P5: never auto-invalidate a human binding). Best-effort and
// bounded to the seeded set, so a live-discovery empty never invalidates anything.
// Returns the number of bindings invalidated (for telemetry).
export async function applyStaleness(store: GraphStore, state: AgentStateType): Promise<number> {
	const seeded = state.resolvedIdentifiers?.graphSeeded ?? [];
	const focus = state.investigationFocus;
	if (seeded.length === 0 || !focus || focus.services.length !== 1) return 0;
	const notFound = datasourcesReportingNotFound(state);
	if (notFound.size === 0) return 0;

	const service = focus.services[0];
	if (!service) return 0;
	// Look up the stored bindings so we know each seeded identifier's datasource +
	// kind + discoveredBy (graphSeeded is just resourceId strings).
	const stored: ServiceBinding[] = await bindingsForServices(store, [service], [normalize(service)]);
	const seededSet = new Set(seeded.map((s) => s.toLowerCase()));
	const resultsById = new Map<string, DataSourceResult>();
	for (const r of state.dataSourceResults ?? []) resultsById.set(r.dataSourceId, r);

	let invalidated = 0;
	for (const b of stored) {
		if (!seededSet.has(b.resourceId.toLowerCase())) continue; // not injected this turn
		if (!notFound.has(b.datasource)) continue; // its datasource didn't report not-found
		// SIO-1103 CodeRabbit: a datasource-level not-found must not retire a DIFFERENT
		// coordinate on the same datasource. The ToolError carries no structured resource,
		// so isolate the failed coordinate by the signal we DO have: retire this binding
		// only if its exact resourceId did NOT appear in the datasource's tool outputs
		// (used-and-present means it's fine even if a sibling coordinate 404'd).
		if (identifierUsedInToolCalls(b.resourceId, resultsById.get(b.datasource)) === true) continue;
		if (b.discoveredBy === "human") {
			await flagBindingForReview(
				store,
				service,
				b.datasource,
				b.kind,
				b.resourceId,
				"seeded coordinate reported not-found",
			);
		} else {
			await invalidateBinding(
				store,
				service,
				b.datasource,
				b.kind,
				b.resourceId,
				"seeded coordinate reported not-found",
			);
			invalidated += 1;
		}
	}
	return invalidated;
}

// recordBindings node: MERGE each confirmed binding into the graph, and (only when
// the agent-memory backend is on -- SIO-970 independence) write a durable fact for
// NEW bindings. A re-confirmation bumps lastVerified graph-side only; the hasBinding
// gate keeps append-only facts from doubling. Soft-fails to partialFailures.
export async function recordConfirmedBindings(state: AgentStateType): Promise<Partial<AgentStateType>> {
	if (!isKnowledgeGraphEnabled() || !isBindingsWriteEnabled()) return {};
	try {
		const records = deriveConfirmedBindings(state);
		// Staleness can retire dead SEEDED bindings even on a turn that confirmed nothing
		// new, so it must not be short-circuited by an empty records list.
		const hasStalenessWork = isStalenessEnabled() && (state.resolvedIdentifiers?.graphSeeded?.length ?? 0) > 0;
		// SIO-1204: the network map persists even on a turn that confirmed no telemetry
		// bindings -- it is derived from toolOutputs, not from resolveIdentifiers.
		const networkRecord = isNetworkWriteEnabled()
			? deriveNetworkTopology(state.networkTopology, state.requestId)
			: undefined;
		// SIO-1457: same independence for the application map's observed service
		// edges (priorKnowledge overlay edges are excluded by the derive).
		const appMapRecord = isAppMapWriteEnabled() ? deriveApplicationTopology(state.applicationTopology) : undefined;
		if (records.length === 0 && !hasStalenessWork && !networkRecord && !appMapRecord) return {};
		const store = await getGraphStore();
		const contradicted = hasStalenessWork ? await applyStaleness(store, state) : 0;
		let newCount = 0;
		let reconfirmed = 0;
		for (const rec of records) {
			// SIO-1127 (CodeRabbit PR #406): scope dedup to the full datasource:kind:resourceId
			// identity so the same coordinate under a different datasource still mirrors its fact.
			const existed = await hasBinding(store, rec.service, rec.kind, rec.resourceId, rec.datasource);
			await recordServiceBinding(store, rec);
			if (existed) {
				reconfirmed += 1;
				continue;
			}
			newCount += 1;
			// Durable fact (system of record). recordKeyDecision self-gates on the
			// agent-memory backend, so a file-backend deployment writes graph-only.
			recordKeyDecision({
				requestId: state.requestId,
				decision: `Confirmed telemetry binding: ${rec.service} observed in ${rec.datasource} as ${rec.kind}=${rec.resourceId}`,
				annotations: {
					kind: "kg-binding",
					service: rec.service,
					service_normalized: rec.serviceNormalized,
					binding_kind: rec.kind,
					resource_id: rec.resourceId,
					locator: rec.locator ?? "",
					datasource: rec.datasource,
					discovered_by: rec.discoveredBy,
					incident_id: state.requestId,
					confidence: String(rec.confidence),
				},
			});
		}
		// SIO-1204: the network write gets its OWN try/catch so a network failure never
		// masks the binding telemetry above (and vice versa -- bindings already wrote).
		let networkFailed = false;
		if (networkRecord) {
			try {
				await recordNetworkTopology(store, networkRecord, state.requestId);
			} catch (error) {
				networkFailed = true;
				logger.warn(
					{ error: error instanceof Error ? error.message : String(error) },
					"recordBindings network-topology write failed; continuing",
				);
			}
		}
		// SIO-1457: the app-map write gets its OWN try/catch for the same isolation
		// reason -- a failed DEPENDS_ON/CONSUMES_FROM merge must not mask bindings or
		// the network map (both already wrote above).
		let appMapFailed = false;
		if (appMapRecord) {
			try {
				await recordAppMapTopologyEdges(store, "depends-on", appMapRecord.dependsOn);
				await recordAppMapTopologyEdges(store, "consumes-from", appMapRecord.consumesFrom);
			} catch (error) {
				appMapFailed = true;
				logger.warn(
					{ error: error instanceof Error ? error.message : String(error) },
					"recordBindings app-map write failed; continuing",
				);
			}
		}
		// SIO-1102/1103: per-turn telemetry. `contradicted` = seeded bindings retired this
		// turn because their datasource reported not-found (staleness).
		logger.info(
			{
				total: records.length,
				newBindings: newCount,
				reconfirmed,
				contradicted,
				networkNodes: networkRecord
					? networkRecord.vpcs.length +
						networkRecord.subnets.length +
						networkRecord.loadBalancers.length +
						networkRecord.targetGroups.length +
						networkRecord.dnsRecords.length +
						networkRecord.endpoints.length
					: 0,
				networkIpBindings: networkRecord?.ipBindings.length ?? 0,
				appMapDependsOn: appMapRecord?.dependsOn.length ?? 0,
				appMapConsumesFrom: appMapRecord?.consumesFrom.length ?? 0,
			},
			"agent:record-bindings",
		);
		const partialFailures: Array<{ node: string; reason: string }> = [];
		if (networkFailed) partialFailures.push({ node: "recordBindings", reason: "network-write-failed" });
		if (appMapFailed) partialFailures.push({ node: "recordBindings", reason: "app-map-write-failed" });
		if (partialFailures.length > 0) return { partialFailures };
		return {};
	} catch (error) {
		logger.warn(
			{ error: error instanceof Error ? error.message : String(error) },
			"recordBindings graph write failed; continuing",
		);
		return { partialFailures: [{ node: "recordBindings", reason: "graph-write-failed" }] };
	}
}

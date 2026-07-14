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
	getGraphStore,
	hasBinding,
	isKnowledgeGraphEnabled,
	recordServiceBinding,
	type ServiceBindingRecord,
} from "@devops-agent/knowledge-graph";
import { getLogger } from "@devops-agent/observability";
import { type DataSourceResult, isDegradingCategory, type ResolvedIdentifiers } from "@devops-agent/shared";
import { normalize } from "./correlation/focus-match.ts";
import { recordKeyDecision } from "./memory-writer.ts";
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
	if (!result || result.status !== "success") return false;
	return (result.toolErrors ?? []).every((e) => !isDegradingCategory(e.category));
}

// SIO-1102: was this specific identifier actually USED by the datasource this turn?
// toolOutputs capture each tool call's parsed output (`rawJson`, not input args -- the
// state shape carries no args), so a resolved coordinate that the fan-out genuinely
// queried is echoed in (or returned by) at least one tool output. Case-insensitive
// substring match over the stringified outputs. This is the identifier-level tightening
// of Stage 1's datasource-level "had findings" heuristic: an identifier the probe
// resolved but the sub-agent never touched is NOT confirmed. Returns `null` (not
// false) when there are no tool outputs to judge against, so the caller can fall back
// to the datasource-level signal rather than dropping everything.
export function identifierUsedInToolCalls(identifier: string, result: DataSourceResult | undefined): boolean | null {
	if (!identifier) return false;
	const outputs = result?.toolOutputs ?? [];
	if (outputs.length === 0) return null;
	const needle = identifier.toLowerCase();
	for (const o of outputs) {
		const hay = (typeof o.rawJson === "string" ? o.rawJson : JSON.stringify(o.rawJson ?? "")).toLowerCase();
		if (hay.includes(needle)) return true;
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
	for (const name of resolved.elastic?.serviceNames ?? []) {
		out.push({ datasource: "elastic", kind: "serviceName", resourceId: name });
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

// recordBindings node: MERGE each confirmed binding into the graph, and (only when
// the agent-memory backend is on -- SIO-970 independence) write a durable fact for
// NEW bindings. A re-confirmation bumps lastVerified graph-side only; the hasBinding
// gate keeps append-only facts from doubling. Soft-fails to partialFailures.
export async function recordConfirmedBindings(state: AgentStateType): Promise<Partial<AgentStateType>> {
	if (!isKnowledgeGraphEnabled() || !isBindingsWriteEnabled()) return {};
	try {
		const records = deriveConfirmedBindings(state);
		if (records.length === 0) return {};
		const store = await getGraphStore();
		let newCount = 0;
		let reconfirmed = 0;
		for (const rec of records) {
			const existed = await hasBinding(store, rec.service, rec.kind, rec.resourceId);
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
		// SIO-1102: per-turn telemetry. `contradicted` (a graph-seeded binding used this
		// turn that yielded nothing) is a Stage 4 staleness concept -- 0 here for now.
		logger.info(
			{ total: records.length, newBindings: newCount, reconfirmed, contradicted: 0 },
			"agent:record-bindings",
		);
		return {};
	} catch (error) {
		logger.warn(
			{ error: error instanceof Error ? error.message : String(error) },
			"recordBindings graph write failed; continuing",
		);
		return { partialFailures: [{ node: "recordBindings", reason: "graph-write-failed" }] };
	}
}

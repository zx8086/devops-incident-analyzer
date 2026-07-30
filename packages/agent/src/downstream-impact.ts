// agent/src/downstream-impact.ts
//
// SIO-1305: fuse the KG's runtime DEPENDS_ON radius (APM-derived, read by
// graphEnrich into state.graphBlastRadius) with Orbit's code radius (SIO-1303's
// definition name-match consumers, read from this turn's gitlab orbitFindings)
// into ONE deterministic downstream-impact answer. Deterministic means: this is a
// pure function of already-fetched state, rendered as-is -- never LLM discretion
// on whether a dependent appears. Two independent sources naming the same
// dependent is a stronger claim than either alone, so entries are labeled
// CONFIRMED (both sources) vs single-source (APM only / code only).

import type { TopologyEdgeRecord } from "@devops-agent/knowledge-graph";
import type { GraphBlastRadiusHit, OrbitBlastRadius } from "@devops-agent/shared";
import { normalize } from "@devops-agent/shared";
import { selectResultWithFindings } from "./correlation/select-result.ts";
import type { AgentStateType } from "./state.ts";

// SIO-1305: this turn's Orbit blast-radius findings, mirroring correlation/rules.ts's
// file-private getOrbitFindings. Exported here (the shared home for both the write
// path in graph-knowledge.ts and the render path in aggregator.ts) rather than
// duplicated in each caller -- CodeRabbit (PR #547) caught the third independent
// copy that would otherwise drift.
export function orbitBlastRadiusFindings(state: AgentStateType): OrbitBlastRadius[] {
	const result = selectResultWithFindings(state.dataSourceResults, "gitlab", "orbitFindings");
	if (result?.status !== "success") return [];
	return result.orbitFindings?.blastRadius ?? [];
}

export type ImpactSource = "apm" | "code" | "confirmed";

export interface DownstreamImpactEntry {
	incidentService: string;
	dependent: string;
	source: ImpactSource;
}

// normalize() does not trim whitespace, so " svc " and "svc" produce distinct
// keys and would silently fail to match -- trim before normalizing everywhere a
// lookup key is derived from a name that might carry incidental whitespace
// (CodeRabbit, PR #547).
function normalizedKey(name: string): string {
	return normalize(name.trim());
}

// Orbit's sourceProject is projectFromPath's two-segment prefix (e.g.
// "pvhcorp/styles-v3-service"), a repo-shaped identifier -- normalize() is built
// for bare service-name-like tokens (it strips -service/-consumer/etc suffixes)
// and does not segment on "/", so it must be applied to the REPO NAME (the last
// path segment), not the full group/repo path.
function repoName(sourceProject: string): string {
	const parts = sourceProject.split("/").filter(Boolean);
	return parts[parts.length - 1] ?? sourceProject;
}

// SIO-1305: resolve Orbit's SIO-1303 definition name-match consumer repos to
// canonical Service names. P6 discipline (same as kg-topology.ts's APM/ECS
// collectors): a consumer repo is written/rendered ONLY when its Orbit project
// path normalize()-matches an ALREADY-KNOWN service name; unmappable repos are
// skipped, never guessed into a new Service identity. Edge-confirmed (non-
// fallback) findings are excluded -- those already flow through the APM sweep's
// own DEPENDS_ON signal, so only radiusMode: "definition-name-match" rows are
// code-derived consumer evidence here.
export function resolveOrbitConsumerEdges(
	findings: OrbitBlastRadius[],
	incidentServices: string[],
	knownServiceNames: string[],
): TopologyEdgeRecord[] {
	const byNormalized = new Map(knownServiceNames.map((name) => [normalizedKey(name), name]));
	const incidentSet = new Set(incidentServices.map(normalizedKey));
	const edges: TopologyEdgeRecord[] = [];
	const seen = new Set<string>();
	for (const finding of findings) {
		if (finding.radiusMode !== "definition-name-match") continue;
		// The incident service the definition's OWN project resolves to -- the
		// canonical "to" endpoint (this is the failing service).
		const definitionService = finding.sourceProject
			? byNormalized.get(normalizedKey(repoName(finding.sourceProject)))
			: undefined;
		const to = definitionService && incidentSet.has(normalizedKey(definitionService)) ? definitionService : undefined;
		if (!to) continue;
		// A name-match finding has no confirmed importer (that's the point of the
		// fallback), so the consumer signal is the OTHER distinct sourceProject
		// values Orbit returned for the same symbol search -- one finding per repo
		// where the name co-occurs; any repo other than the definition's own is a
		// candidate consumer.
		for (const other of findings) {
			if (other === finding || other.radiusMode !== "definition-name-match") continue;
			if (!other.sourceProject) continue;
			const from = byNormalized.get(normalizedKey(repoName(other.sourceProject)));
			if (!from || from === to) continue;
			const key = `${from} ${to}`;
			if (seen.has(key)) continue;
			seen.add(key);
			edges.push({ kind: "depends-on", from, to });
		}
	}
	return edges;
}

// SIO-1305: fuse the two sources into one enumeration, direction-aware. Only
// CALLERS of an incident service (who breaks downstream) belong here -- the
// incident service's own dependencies are candidate upstream causes, a different
// question the existing graphContext "Known dependencies" section already
// answers, so they are deliberately excluded to avoid presenting the same edge
// under two conflicting labels.
export function buildDownstreamImpact(
	graphBlastRadius: GraphBlastRadiusHit[],
	orbitConsumerEdges: TopologyEdgeRecord[],
	incidentServices: string[],
): DownstreamImpactEntry[] {
	const incidentSet = new Set(incidentServices.map(normalizedKey));
	// Canonical-name maps keyed by the same trim+normalize() (normalizedKey) so an
	// APM hit and an Orbit edge that name the same service/dependent with
	// different casing/whitespace still merge into ONE entry (and can be labeled
	// confirmed). The first-seen spelling per key is kept as the display name --
	// APM and Orbit both source from real service identifiers, so any spelling is
	// representative.
	const canonical = new Map<string, string>();
	function canonicalize(name: string): string {
		const k = normalizedKey(name);
		const existing = canonical.get(k);
		if (existing) return existing;
		canonical.set(k, name);
		return name;
	}
	// APM: blastRadiusForServices' "depends-on" hits are both-direction (SIO-1104
	// note in rules.ts) -- keep only the ones where the INCIDENT service is the
	// dependency target (hit.neighbour depends on hit.service), i.e. the neighbour
	// is a caller of the incident service, not the other way round. There is no
	// direction flag on BlastRadiusHit, so this is necessarily a best-effort
	// same-set inclusion: both directions of a depends-on edge produce a hit with
	// service=A,neighbour=B AND service=B,neighbour=A, and only the incident-
	// anchored row (service is the incident service) is a "who calls us" claim.
	const apmDependents = new Map<string, Set<string>>();
	for (const hit of graphBlastRadius) {
		if (hit.via !== "depends-on") continue;
		if (!incidentSet.has(normalizedKey(hit.service))) continue;
		const service = canonicalize(hit.service);
		const set = apmDependents.get(service) ?? new Set<string>();
		set.add(canonicalize(hit.neighbour));
		apmDependents.set(service, set);
	}
	const codeDependents = new Map<string, Set<string>>();
	for (const edge of orbitConsumerEdges) {
		const service = canonicalize(edge.to);
		const set = codeDependents.get(service) ?? new Set<string>();
		set.add(canonicalize(edge.from));
		codeDependents.set(service, set);
	}
	const entries: DownstreamImpactEntry[] = [];
	const services = new Set([...apmDependents.keys(), ...codeDependents.keys()]);
	for (const service of services) {
		const apm = apmDependents.get(service) ?? new Set<string>();
		const code = codeDependents.get(service) ?? new Set<string>();
		const dependents = new Set([...apm, ...code]);
		for (const dependent of dependents) {
			const inApm = apm.has(dependent);
			const inCode = code.has(dependent);
			const source: ImpactSource = inApm && inCode ? "confirmed" : inApm ? "apm" : "code";
			entries.push({ incidentService: service, dependent, source });
		}
	}
	// Deterministic order: confirmed first, then by service/dependent name. A plain
	// code-point comparator (not localeCompare, which is locale/ICU-version
	// dependent) so the rendered prompt bytes are stable across environments.
	const rank: Record<ImpactSource, number> = { confirmed: 0, apm: 1, code: 2 };
	const byCodePoint = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
	entries.sort(
		(a, b) =>
			rank[a.source] - rank[b.source] ||
			byCodePoint(a.incidentService, b.incidentService) ||
			byCodePoint(a.dependent, b.dependent),
	);
	return entries;
}

const SOURCE_LABEL: Record<ImpactSource, string> = {
	confirmed: "CONFIRMED (APM runtime + Orbit code, two independent sources)",
	apm: "single-source (APM runtime dependency only)",
	code: "single-source (Orbit code co-occurrence only)",
};

// Rendered as a bounded, labeled list for the aggregator prompt (SIO-1204/1215
// bounded-render convention: the underlying data isn't card-rendered here, so no
// separate MAX_LINES cap is needed beyond ordinary prompt hygiene -- entries.length
// is already bounded by blastRadiusForServices' own limit and Orbit's finding count).
export function summarizeDownstreamImpactForPrompt(entries: DownstreamImpactEntry[]): string {
	if (entries.length === 0) return "";
	return entries.map((e) => `- ${e.dependent} depends on ${e.incidentService} -- ${SOURCE_LABEL[e.source]}`).join("\n");
}

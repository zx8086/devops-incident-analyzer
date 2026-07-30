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

export type ImpactSource = "apm" | "code" | "confirmed";

export interface DownstreamImpactEntry {
	incidentService: string;
	dependent: string;
	source: ImpactSource;
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
	const byNormalized = new Map(knownServiceNames.map((name) => [normalize(name), name]));
	const incidentSet = new Set(incidentServices.map((s) => normalize(s)));
	const edges: TopologyEdgeRecord[] = [];
	const seen = new Set<string>();
	for (const finding of findings) {
		if (finding.radiusMode !== "definition-name-match") continue;
		// The incident service the definition's OWN project resolves to -- the
		// canonical "to" endpoint (this is the failing service).
		const definitionService = finding.sourceProject
			? byNormalized.get(normalize(repoName(finding.sourceProject)))
			: undefined;
		const to = definitionService && incidentSet.has(normalize(definitionService)) ? definitionService : undefined;
		if (!to) continue;
		// A name-match finding has no confirmed importer (that's the point of the
		// fallback), so the consumer signal is the OTHER distinct sourceProject
		// values Orbit returned for the same symbol search -- one finding per repo
		// where the name co-occurs; any repo other than the definition's own is a
		// candidate consumer.
		for (const other of findings) {
			if (other === finding || other.radiusMode !== "definition-name-match") continue;
			if (!other.sourceProject) continue;
			const from = byNormalized.get(normalize(repoName(other.sourceProject)));
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
	const incidentSet = new Set(incidentServices.map((s) => normalize(s)));
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
		if (!incidentSet.has(normalize(hit.service))) continue;
		const set = apmDependents.get(hit.service) ?? new Set<string>();
		set.add(hit.neighbour);
		apmDependents.set(hit.service, set);
	}
	const codeDependents = new Map<string, Set<string>>();
	for (const edge of orbitConsumerEdges) {
		const set = codeDependents.get(edge.to) ?? new Set<string>();
		set.add(edge.from);
		codeDependents.set(edge.to, set);
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
	// Deterministic order: confirmed first, then by service/dependent name.
	const rank: Record<ImpactSource, number> = { confirmed: 0, apm: 1, code: 2 };
	entries.sort(
		(a, b) =>
			rank[a.source] - rank[b.source] ||
			a.incidentService.localeCompare(b.incidentService) ||
			a.dependent.localeCompare(b.dependent),
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

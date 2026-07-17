// agent/src/learn/curation-facts.ts
//
// SIO-1135: durable kg-incident / kg-root-cause mirror facts are written at CURATION
// time (a human links a Jira ticket), not per-run. Facts are immutable and only curated
// investigations are durable memory (SIO-1134), so a per-run mirror would let
// rebuild-from-facts resurrect every uncurated incident forever. Both curation seams --
// learn/apply.ts and the ticket-creation curateIncident endpoint -- call this to mirror
// the CURRENT graph row, so the annotations match the rebuild.ts mappers
// (incidentFromAnnotations / rootCauseFromAnnotations) byte-for-byte.

import { type GraphStore, incidentById, rootCauseForIncident } from "@devops-agent/knowledge-graph";
import { recordKeyDecision } from "../memory-writer.ts";

export interface CurationMirrorOptions {
	// The turn whose fact write this is (agent-memory groups by requestId).
	requestId: string;
	ticketKey: string;
	// apply.ts already writes these facts on its own paths (create / approved rootCause)
	// this turn; set to skip a duplicate write here.
	skipIncidentFact?: boolean;
	skipRootCauseFact?: boolean;
}

export interface CurationMirrorResult {
	incidentFactWritten: boolean;
	rootCauseFactWritten: boolean;
}

// Read the incident (+ its root cause) from the graph and write the durable mirror facts
// with rebuild-parity annotations. recordKeyDecision self-gates on the agent-memory
// backend (no-op on the file backend), so this is safe to call unconditionally at a
// curation seam. Returns which facts were written for logging.
export async function writeCurationMirrorFacts(
	store: GraphStore,
	incidentId: string,
	opts: CurationMirrorOptions,
): Promise<CurationMirrorResult> {
	const result: CurationMirrorResult = { incidentFactWritten: false, rootCauseFactWritten: false };
	if (!incidentId) return result;

	if (!opts.skipIncidentFact) {
		const incident = await incidentById(store, incidentId);
		if (incident) {
			recordKeyDecision({
				requestId: opts.requestId,
				decision: `Incident ${incidentId}: ${incident.summary} (curated via ${opts.ticketKey})`,
				annotations: {
					// Byte-parity with incidentFromAnnotations (rebuild.ts): incident_id (required),
					// severity, services (comma-joined), summary. source/ticket are extra provenance
					// keys the mapper ignores.
					kind: "kg-incident",
					incident_id: incidentId,
					services: incident.services.join(","),
					severity: incident.severity,
					summary: incident.summary,
					source: "curation",
					ticket: opts.ticketKey,
				},
			});
			result.incidentFactWritten = true;
		}
	}

	if (!opts.skipRootCauseFact) {
		const rc = await rootCauseForIncident(store, incidentId);
		if (rc) {
			recordKeyDecision({
				requestId: opts.requestId,
				decision: `Root cause for incident ${incidentId} (curated via ${opts.ticketKey}): ${rc.ruleName || rc.class}`,
				annotations: {
					// Byte-parity with rootCauseFromAnnotations (rebuild.ts): incident_id,
					// root_cause_id, rule_name (all required), description, confidence.
					kind: "kg-root-cause",
					incident_id: incidentId,
					root_cause_id: rc.id,
					rule_name: rc.ruleName || rc.class,
					description: rc.description,
					confidence: String(rc.confidence),
					source: "curation",
					ticket: opts.ticketKey,
				},
			});
			result.rootCauseFactWritten = true;
		}
	}

	return result;
}

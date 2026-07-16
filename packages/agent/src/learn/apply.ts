// agent/src/learn/apply.ts
//
// SIO-1126: write the approved learnings. Root-cause corrections replace the
// machine-derived HAS_ROOT_CAUSE edge (recordRootCause deletes the prior edge by
// design) and activate the previously-dead RESOLVED_BY read path via
// linkResolution. Every KG write mirrors a durable agent-memory fact whose
// annotation shape the rebuild replays (SIO-1103); the narrative hil-resolution
// fact is the re-learn dedup anchor (immutable facts double on re-write). All
// writes soft-fail: learning never breaks the turn.

import { createHash } from "node:crypto";
import {
	getGraphStore,
	isKnowledgeGraphEnabled,
	linkResolution,
	recordIncident,
	recordRootCause,
	setIncidentEmbedding,
} from "@devops-agent/knowledge-graph";
import { getLogger } from "@devops-agent/observability";
import { AIMessage } from "@langchain/core/messages";
import { recordKeyDecision } from "../memory-writer.ts";
import { getRunbookCatalog } from "../prompt-context.ts";
import type { AgentStateType } from "../state.ts";
import type { RootCauseCorrection } from "./schema.ts";

const logger = getLogger("agent:learn:apply");

export interface HilApplyReport {
	incidentId: string;
	incidentCreated: boolean;
	rootCauseWritten: boolean;
	runbookLinked?: string;
	factsWritten: number;
	skipped: Array<{ id: string; reason: string }>;
}

// Compose the RootCause description the aggregator will render verbatim via the
// existing "prior root cause: <description>" line -- cause, fix, and what was
// ruled out all travel in one string so the reader needs zero changes (Phase 1).
const MAX_DESCRIPTION_CHARS = 700;
export function composeRootCauseDescription(rc: RootCauseCorrection, ticketKey: string): string {
	const parts = [rc.description.trim(), `Resolution: ${rc.resolution.trim()}`];
	if (rc.invalidatedHypotheses.length > 0) {
		parts.push(`Ruled out: ${rc.invalidatedHypotheses.map((h) => `${h.hypothesis} -- ${h.reason}`).join("; ")}`);
	}
	parts.push(`(human-corrected via ${ticketKey})`);
	const text = parts.join(" ");
	return text.length <= MAX_DESCRIPTION_CHARS ? text : `${text.slice(0, MAX_DESCRIPTION_CHARS - 3)}...`;
}

export function buildApplySummary(report: HilApplyReport, ticketKey: string): string {
	const lines = [`Learned from ${ticketKey}.`];
	if (report.incidentCreated) {
		lines.push(`- Created incident record ${report.incidentId} (no stored investigation matched).`);
	}
	if (report.rootCauseWritten) {
		lines.push("- Recorded the human-corrected root cause (replaces any machine-derived cause for this incident).");
	}
	if (report.runbookLinked) {
		lines.push(
			`- Linked the resolution to runbook ${report.runbookLinked}; similar future incidents will surface "resolved by ${report.runbookLinked}".`,
		);
	}
	if (report.factsWritten > 0) {
		lines.push(`- Wrote ${report.factsWritten} durable memory fact(s) for future recall.`);
	}
	for (const s of report.skipped) {
		lines.push(`- Skipped ${s.id}: ${s.reason}.`);
	}
	if (lines.length === 1) {
		lines.push("- Nothing was approved, so nothing was recorded.");
	}
	return lines.join("\n");
}

function approved(decisions: Record<string, "approve" | "reject">, id: string): boolean {
	return decisions[id] !== "reject";
}

// applyLearnings node: terminal writer for the lane. Appends the apply summary
// as an AIMessage (the iac idiom -- the resume endpoint reads it back via
// getLastAssistantText).
export async function applyLearnings(state: AgentStateType): Promise<Partial<AgentStateType>> {
	const proposal = state.hilProposal;
	const match = state.hilMatch;
	const decisions = state.hilDecisions;
	if (!proposal || !match || !decisions) return {};

	const ticketKey = proposal.ticketKey;
	const alreadyLearned = state.hilAlreadyLearned === true;
	const report: HilApplyReport = {
		incidentId: match.incidentId,
		incidentCreated: false,
		rootCauseWritten: false,
		factsWritten: 0,
		skipped: [],
	};
	const failures: Array<{ node: string; reason: string }> = [];

	if (isKnowledgeGraphEnabled()) {
		try {
			const store = await getGraphStore();

			if (match.created) {
				await recordIncident(store, {
					id: match.incidentId,
					summary: `${ticketKey}: ${state.hilTicket?.summary ?? ""}`.slice(0, 280),
					services: [],
				});
				// Vector-indexed column: only writable via the drop/set/recreate path.
				if (state.hilTicketEmbedding && state.hilTicketEmbedding.length > 0) {
					await setIncidentEmbedding(store, match.incidentId, state.hilTicketEmbedding);
				}
				report.incidentCreated = true;
				recordKeyDecision({
					requestId: state.requestId,
					decision: `Incident ${match.incidentId}: ${ticketKey} (created by HIL learning)`,
					annotations: {
						kind: "kg-incident",
						incident_id: match.incidentId,
						services: "",
						severity: "",
						summary: `${ticketKey}: ${state.hilTicket?.summary ?? ""}`.slice(0, 280),
						source: "hil",
						ticket: ticketKey,
					},
				});
			}

			const rc = proposal.rootCause;
			if (rc && approved(decisions, rc.id)) {
				// ruleName == class == causeClass is FORCED by rebuild parity:
				// rootCauseFromAnnotations reconstructs class from rule_name. Human
				// provenance lives in the mirror annotations + description suffix.
				const id = createHash("sha256").update(rc.causeClass).digest("hex").slice(0, 16);
				const description = composeRootCauseDescription(rc, ticketKey);
				await recordRootCause(store, {
					id,
					incidentId: match.incidentId,
					class: rc.causeClass,
					description,
					confidence: 1.0,
					ruleName: rc.causeClass,
				});
				report.rootCauseWritten = true;
				recordKeyDecision({
					requestId: state.requestId,
					decision: `Root cause for incident ${match.incidentId} (human-corrected via ${ticketKey}): ${rc.causeClass}`,
					annotations: {
						kind: "kg-root-cause",
						incident_id: match.incidentId,
						root_cause_id: id,
						rule_name: rc.causeClass,
						description,
						confidence: "1",
						source: "hil",
						ticket: ticketKey,
					},
				});

				if (rc.runbookFilename) {
					const catalogFilenames = new Set(safeCatalogFilenames());
					if (catalogFilenames.has(rc.runbookFilename)) {
						// First production caller of linkResolution: this is what makes
						// graphEnrich's "resolved by X" line fire on similar incidents.
						await linkResolution(store, match.incidentId, [rc.runbookFilename]);
						report.runbookLinked = rc.runbookFilename;
						recordKeyDecision({
							requestId: state.requestId,
							decision: `Incident ${match.incidentId} resolved by runbook ${rc.runbookFilename} (via ${ticketKey})`,
							annotations: {
								kind: "kg-resolution",
								incident_id: match.incidentId,
								runbook: rc.runbookFilename,
								ticket: ticketKey,
							},
						});
					} else {
						report.skipped.push({ id: rc.id, reason: `runbook ${rc.runbookFilename} is not in the catalog` });
					}
				}
			} else if (rc) {
				report.skipped.push({ id: rc.id, reason: "rejected" });
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			logger.warn({ ticket: ticketKey, error: message }, "HIL graph writes failed");
			failures.push({ node: "applyLearnings", reason: "graph-write-failed" });
		}
	} else {
		report.skipped.push({ id: "graph", reason: "knowledge graph disabled" });
	}

	// Phase 2 (SIO-1127) activates these classes; a Phase 1 distiller emits them
	// empty, but a hand-crafted resume must not silently drop approved items.
	for (const item of [...proposal.bindings, ...proposal.heuristics]) {
		if (approved(decisions, item.id)) {
			report.skipped.push({ id: item.id, reason: "class not applied until SIO-1127 (Phase 2)" });
		}
	}

	if (alreadyLearned) {
		if (proposal.memoryFacts.length > 0) {
			report.skipped.push({ id: "facts", reason: `already learned from ${ticketKey}; facts not re-written` });
		}
	} else {
		try {
			for (const fact of proposal.memoryFacts) {
				if (!approved(decisions, fact.id)) {
					report.skipped.push({ id: fact.id, reason: "rejected" });
					continue;
				}
				recordKeyDecision({
					requestId: state.requestId,
					decision: fact.text,
					annotations: {
						kind: "hil-resolution",
						ticket: ticketKey,
						incident_id: match.incidentId,
						item_id: fact.id,
					},
				});
				report.factsWritten += 1;
			}
			// Narrative summary fact: the deterministic dedup anchor for re-learns.
			if (report.rootCauseWritten || report.factsWritten > 0) {
				recordKeyDecision({
					requestId: state.requestId,
					decision: `HIL resolution learned from ${ticketKey}: ${proposal.rootCause?.causeClass ?? "memory facts only"} (incident ${match.incidentId})`,
					annotations: {
						kind: "hil-resolution",
						ticket: ticketKey,
						incident_id: match.incidentId,
						item_id: "summary",
						cause_class: proposal.rootCause?.causeClass ?? "",
					},
				});
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			logger.warn({ ticket: ticketKey, error: message }, "HIL memory fact writes failed");
			failures.push({ node: "applyLearnings", reason: "memory-write-failed" });
		}
	}

	logger.info(
		{
			ticket: ticketKey,
			incidentId: report.incidentId,
			rootCauseWritten: report.rootCauseWritten,
			runbookLinked: report.runbookLinked ?? null,
			factsWritten: report.factsWritten,
			skipped: report.skipped.length,
		},
		"HIL learnings applied",
	);

	return {
		messages: [new AIMessage(buildApplySummary(report, ticketKey))],
		...(failures.length > 0 ? { partialFailures: failures } : {}),
	};
}

function safeCatalogFilenames(): string[] {
	try {
		return getRunbookCatalog().map((r) => r.filename);
	} catch {
		return [];
	}
}

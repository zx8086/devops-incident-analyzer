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
	BindingKindSchema,
	getGraphStore,
	hasBinding,
	invalidateBindingByHuman,
	isKnowledgeGraphEnabled,
	linkIncidentTicket,
	linkResolution,
	recordIncident,
	recordRootCause,
	recordServiceBinding,
	setIncidentEmbedding,
} from "@devops-agent/knowledge-graph";
import { getLogger } from "@devops-agent/observability";
import type {
	BindingCorrection,
	Heuristic,
	HilApplyItem,
	HilApplyReport,
	HilDecisions,
	LearningProposal,
} from "@devops-agent/shared";
import { normalize } from "@devops-agent/shared";
import { AIMessage } from "@langchain/core/messages";
import { promoteToMemory } from "../memory-promotion.ts";
import { isLiveMemoryEnabled, recordKeyDecision } from "../memory-writer.ts";
import { getRunbookCatalog } from "../prompt-context.ts";
import { buildSkillAnnotations, buildSkillFactText, skillProposalExists } from "../skill-learner.ts";
import type { AgentStateType } from "../state.ts";
import { writeCurationMirrorFacts } from "./curation-facts.ts";
import { applyEdits } from "./edits.ts";
import { draftRunbookFilename, RUNBOOK_DIR, renderRunbookMarkdown } from "./runbook.ts";
import type { RootCauseCorrection } from "./schema.ts";

const logger = getLogger("agent:learn:apply");

// SIO-1146: the report shape moved to @devops-agent/shared (the UI renders it as
// the terminal outcome card); re-exported so existing imports keep working.
export type { HilApplyReport };

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
	if (report.curated) {
		lines.push(
			`- Linked this investigation to ${ticketKey} as its canonical record; future "learn from ${ticketKey}" resolves it directly.`,
		);
	}
	if (report.factsWritten > 0) {
		lines.push(`- Wrote ${report.factsWritten} durable memory fact(s) for future recall.`);
	}
	if (report.bindingsConfirmed > 0) {
		lines.push(
			`- Confirmed ${report.bindingsConfirmed} telemetry binding(s) (human-verified; they re-seed identifier resolution).`,
		);
	}
	if (report.bindingsInvalidated > 0) {
		lines.push(`- Invalidated ${report.bindingsInvalidated} stale telemetry binding(s).`);
	}
	if (report.heuristicsProposed > 0) {
		lines.push(
			`- Proposed ${report.heuristicsProposed} diagnostic skill(s); promote with \`bun run skill:promote\` after review.`,
		);
	}
	if (report.draftRunbookUrl) {
		lines.push(`- Opened a DRAFT runbook PR for review: ${report.draftRunbookUrl}`);
	}
	for (const s of report.skipped) {
		lines.push(`- Skipped ${s.id}: ${s.reason}.`);
	}
	if (lines.length === 1) {
		lines.push("- Nothing was approved, so nothing was recorded.");
	}
	return lines.join("\n");
}

// Explicit approval required: a missing entry (partial/malformed resume payload)
// must never write an unreviewed learning (CodeRabbit, PR #392). The card always
// sends the full decisions map, so a gap only occurs on hand-crafted payloads.
function approved(decisions: Record<string, "approve" | "reject">, id: string): boolean {
	return decisions[id] === "approve";
}

const MAX_ITEM_LABEL_CHARS = 120;
function truncateLabel(text: string): string {
	const trimmed = text.trim();
	return trimmed.length <= MAX_ITEM_LABEL_CHARS ? trimmed : `${trimmed.slice(0, MAX_ITEM_LABEL_CHARS - 3)}...`;
}

// SIO-1146: per-item outcome rows for the terminal learning card. Statuses come
// from `appliedIds` (populated at the actual write points), NOT from `skipped`
// alone -- block-level skips (KG disabled, live memory off, a mid-block graph
// failure) leave no per-item entries, so a skipped-lookup would over-report
// "applied". A rejected decision always wins over any same-id skip entry; an
// applied root cause keeps a same-id skip entry (draft-runbook PR outcome) as
// supplementary reason text.
export function buildApplyItems(
	proposal: LearningProposal,
	decisions: HilDecisions,
	report: HilApplyReport,
	appliedIds: ReadonlySet<string>,
): HilApplyItem[] {
	const skipReason = (id: string): string | undefined => report.skipped.find((s) => s.id === id)?.reason;
	const toItem = (id: string, kind: HilApplyItem["kind"], label: string, blockId?: string): HilApplyItem => {
		if (!approved(decisions, id)) return { id, kind, label: truncateLabel(label), status: "rejected" };
		if (appliedIds.has(id)) {
			const reason = skipReason(id);
			return { id, kind, label: truncateLabel(label), status: "applied", ...(reason ? { reason } : {}) };
		}
		const reason = skipReason(id) ?? (blockId ? skipReason(blockId) : undefined) ?? "not written";
		return { id, kind, label: truncateLabel(label), status: "skipped", reason };
	};

	const items: HilApplyItem[] = [];
	if (proposal.rootCause) {
		items.push(toItem(proposal.rootCause.id, "root-cause", proposal.rootCause.causeClass, "graph"));
	}
	for (const fact of proposal.memoryFacts) {
		items.push(toItem(fact.id, "memory-fact", fact.text, "facts"));
	}
	for (const binding of proposal.bindings) {
		items.push(
			toItem(
				binding.id,
				"binding",
				`${binding.action} ${binding.service} -> ${binding.datasource} ${binding.bindingKind}=${binding.resourceId}`,
				"graph",
			),
		);
	}
	for (const heuristic of proposal.heuristics) {
		items.push(toItem(heuristic.id, "heuristic", heuristic.name));
	}
	return items;
}

// applyLearnings node: terminal writer for the lane. Appends the apply summary
// as an AIMessage (the iac idiom -- the resume endpoint reads it back via
// getLastAssistantText).
export async function applyLearnings(state: AgentStateType): Promise<Partial<AgentStateType>> {
	const match = state.hilMatch;
	const decisions = state.hilDecisions;
	if (!state.hilProposal || !match || !decisions) return {};
	// SIO-1128: merge the human's text edits over the distiller proposal. applyEdits only
	// touches invariant-free prose fields, so every downstream write/validation is unchanged.
	const proposal = applyEdits(state.hilProposal, state.hilEdits ?? {});

	const ticketKey = proposal.ticketKey;
	const alreadyLearned = state.hilAlreadyLearned === true;
	const report: HilApplyReport = {
		ticketKey,
		incidentId: match.incidentId,
		incidentCreated: false,
		rootCauseWritten: false,
		factsWritten: 0,
		bindingsConfirmed: 0,
		bindingsInvalidated: 0,
		heuristicsProposed: 0,
		skipped: [],
		items: [],
	};
	const failures: Array<{ node: string; reason: string }> = [];
	// SIO-1146: ids whose write actually landed, recorded at the write points --
	// the source of truth for the outcome card's per-item statuses.
	const appliedIds = new Set<string>();

	let curated = false;
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
				// SIO-1135 (CodeRabbit PR #404): the durable kg-incident fact is NOT written here.
				// This block runs before anyApproved is known, so a "Reject all" would otherwise
				// leave an immutable fact for an uncurated incident. The fact is written only in
				// the anyApproved curation path below (writeCurationMirrorFacts reads THIS row).
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
				appliedIds.add(rc.id);
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

				const catalogFilenames = new Set(safeCatalogFilenames());
				if (rc.runbookFilename && catalogFilenames.has(rc.runbookFilename)) {
					// A catalog runbook already covers the fix: link it (first production caller
					// of linkResolution -- makes graphEnrich's "resolved by X" fire on similar
					// incidents). No draft PR in this case (per SIO-1127 decision: draft only when
					// no catalog runbook matches, to avoid duplicate-runbook PRs).
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
					// No catalog runbook covers this cause -> open a PR-gated DRAFT runbook. The
					// file is NEVER written into the runbooks dir directly; the PR merge is the only
					// control (the manifest loader auto-catalogs *.md there on the next load).
					await draftRunbook(rc, ticketKey, report);
				}
			} else if (rc) {
				report.skipped.push({ id: rc.id, reason: "rejected" });
			}

			// SIO-1127: telemetry binding corrections. Confirm (human-verified, byte-parity
			// with the confirm-binding CLI) or invalidate (an explicit human verdict that
			// overrides even a prior human confirmation). Each soft-fails independently.
			for (const binding of proposal.bindings) {
				if (!approved(decisions, binding.id)) {
					report.skipped.push({ id: binding.id, reason: "rejected" });
					continue;
				}
				// Soft-fail each binding INDEPENDENTLY (CodeRabbit PR #406): a single throwing
				// binding must not abort later bindings or the incident curation below.
				try {
					if (await applyBinding(store, binding, ticketKey, state.requestId, report)) {
						appliedIds.add(binding.id);
					}
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					logger.warn({ ticket: ticketKey, binding: binding.id, error: message }, "HIL binding write failed");
					report.skipped.push({ id: binding.id, reason: "binding write failed" });
					failures.push({ node: "applyLearnings", reason: "binding-write-failed" });
				}
			}

			// SIO-1134: applying learnings CURATES the matched incident -- the
			// confirmed ticket linkage is written so this ticket resolves by exact
			// lookup forever after, and the incident counts as durable memory.
			// Gated on at least one approval: with auto-confirmed matches, "Reject
			// all" is the user's only escape from a WRONG match, so it must not
			// persist the link (CodeRabbit, PR #398).
			const anyApproved = [
				...(proposal.rootCause ? [proposal.rootCause.id] : []),
				...proposal.bindings.map((b) => b.id),
				...proposal.heuristics.map((h) => h.id),
				...proposal.memoryFacts.map((f) => f.id),
			].some((id) => approved(decisions, id));
			if (anyApproved) {
				await linkIncidentTicket(store, match.incidentId, ticketKey);
				curated = true;
				recordKeyDecision({
					requestId: state.requestId,
					decision: `Incident ${match.incidentId} is the canonical record for ${ticketKey} (curated via HIL learning)`,
					annotations: {
						kind: "kg-incident-ticket",
						incident_id: match.incidentId,
						ticket: ticketKey,
					},
				});
				// SIO-1135: mirror the incident (+ its root cause) to durable facts now that it
				// is curated -- for BOTH created and existing incidents (the create path no longer
				// writes the fact pre-approval; CodeRabbit PR #404). An approved rootCause already
				// wrote a kg-root-cause fact this turn, so skip only that to avoid a duplicate.
				// writeCurationMirrorFacts reads the current graph row so the created incident's
				// summary round-trips with byte-parity.
				await writeCurationMirrorFacts(store, match.incidentId, {
					requestId: state.requestId,
					ticketKey,
					skipRootCauseFact: report.rootCauseWritten,
				});
			} else {
				report.skipped.push({ id: "curation", reason: "nothing approved; ticket link not written" });
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			logger.warn({ ticket: ticketKey, error: message }, "HIL graph writes failed");
			// SIO-1146 (CodeRabbit PR #412): block-level skip entry so approved items
			// caught by the failure render the real reason, not the "not written" fallback.
			report.skipped.push({ id: "graph", reason: "graph write failed" });
			failures.push({ node: "applyLearnings", reason: "graph-write-failed" });
		}
	} else {
		report.skipped.push({ id: "graph", reason: "knowledge graph disabled" });
	}

	// SIO-1127: heuristics become kind:skill proposal facts (the SIO-1015 pipeline).
	// Promotion stays `bun run skill:promote`. Self-gates on live memory + dedups by
	// skill_name so a re-learn never doubles the immutable fact.
	if (!alreadyLearned && isLiveMemoryEnabled()) {
		for (const heuristic of proposal.heuristics) {
			if (!approved(decisions, heuristic.id)) {
				report.skipped.push({ id: heuristic.id, reason: "rejected" });
				continue;
			}
			try {
				if (await applyHeuristic(heuristic, ticketKey, state.requestId, report)) {
					appliedIds.add(heuristic.id);
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				logger.warn({ ticket: ticketKey, heuristic: heuristic.name, error: message }, "HIL heuristic write failed");
				report.skipped.push({ id: heuristic.id, reason: "heuristic write failed" });
				failures.push({ node: "applyLearnings", reason: "heuristic-write-failed" });
			}
		}
	} else {
		for (const heuristic of proposal.heuristics) {
			if (approved(decisions, heuristic.id)) {
				report.skipped.push({
					id: heuristic.id,
					reason: alreadyLearned
						? `already learned from ${ticketKey}; skill proposal not re-written`
						: "live memory disabled (LIVE_MEMORY_ENABLED)",
				});
			}
		}
	}

	if (alreadyLearned) {
		if (proposal.memoryFacts.length > 0) {
			report.skipped.push({ id: "facts", reason: `already learned from ${ticketKey}; facts not re-written` });
		}
	} else if (!isLiveMemoryEnabled()) {
		// recordKeyDecision silently no-ops when live memory is off; do not count
		// (or claim) fact writes that never persisted (CodeRabbit, PR #392).
		if (proposal.memoryFacts.length > 0) {
			report.skipped.push({ id: "facts", reason: "live memory disabled (LIVE_MEMORY_ENABLED)" });
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
				appliedIds.add(fact.id);
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
			report.skipped.push({ id: "facts", reason: "memory write failed" });
			failures.push({ node: "applyLearnings", reason: "memory-write-failed" });
		}
	}

	report.curated = curated;
	logger.info(
		{
			ticket: ticketKey,
			incidentId: report.incidentId,
			rootCauseWritten: report.rootCauseWritten,
			runbookLinked: report.runbookLinked ?? null,
			draftRunbookUrl: report.draftRunbookUrl ?? null,
			factsWritten: report.factsWritten,
			bindingsConfirmed: report.bindingsConfirmed,
			bindingsInvalidated: report.bindingsInvalidated,
			heuristicsProposed: report.heuristicsProposed,
			skipped: report.skipped.length,
		},
		"HIL learnings applied",
	);

	report.items = buildApplyItems(proposal, decisions, report, appliedIds);

	return {
		messages: [new AIMessage(buildApplySummary(report, ticketKey))],
		hilApplyReport: report,
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

// SIO-1127: write one approved telemetry-binding correction. Confirm re-uses
// recordServiceBinding with the confirm-binding CLI's byte-parity shape (confidence 1.0,
// discoveredBy "human"); invalidate uses the human-explicit writer. bindingKind is
// re-validated against BindingKindSchema (the shared schema promises this at write time);
// an invalid kind is skipped, not written. The kg-binding / kg-binding-invalidated mirror
// facts match the rebuild.ts mappers. Confirm dedups the fact via hasBinding so a re-learn
// does not double the immutable fact.
async function applyBinding(
	store: Awaited<ReturnType<typeof getGraphStore>>,
	binding: BindingCorrection,
	ticketKey: string,
	requestId: string,
	report: HilApplyReport,
): Promise<boolean> {
	const kind = BindingKindSchema.safeParse(binding.bindingKind);
	if (!kind.success) {
		report.skipped.push({ id: binding.id, reason: `unknown binding kind "${binding.bindingKind}"` });
		return false;
	}
	const serviceNormalized = normalize(binding.service);

	if (binding.action === "invalidate") {
		await invalidateBindingByHuman(
			store,
			binding.service,
			binding.datasource,
			kind.data,
			binding.resourceId,
			`hil:${ticketKey} -- ${binding.reason}`,
		);
		report.bindingsInvalidated += 1;
		recordKeyDecision({
			requestId,
			decision: `Invalidated telemetry binding (human, via ${ticketKey}): ${binding.service} !-> ${binding.datasource} ${kind.data}=${binding.resourceId}`,
			annotations: {
				kind: "kg-binding-invalidated",
				service: binding.service,
				service_normalized: serviceNormalized,
				binding_kind: kind.data,
				resource_id: binding.resourceId,
				datasource: binding.datasource,
				reason: binding.reason,
				discovered_by: "human",
				ticket: ticketKey,
			},
		});
		return true;
	}

	// action === "confirm"
	// Scope the dedup to the FULL datasource:kind:resourceId identity (CodeRabbit PR #406)
	// so the same coordinate under a different datasource still writes its mirror fact.
	const existed = await hasBinding(store, binding.service, kind.data, binding.resourceId, binding.datasource);
	await recordServiceBinding(store, {
		service: binding.service,
		serviceNormalized,
		datasource: binding.datasource,
		kind: kind.data,
		resourceId: binding.resourceId,
		locator: binding.locator,
		confidence: 1.0,
		discoveredBy: "human",
		evidence: `hil:${ticketKey}`,
	});
	report.bindingsConfirmed += 1;
	// Immutable-fact dedup: only mirror when the binding is genuinely new (matches the W8
	// idiom -- a re-confirm still bumps the graph edge but must not double the fact).
	if (!existed) {
		recordKeyDecision({
			requestId,
			decision: `Human-confirmed telemetry binding (via ${ticketKey}): ${binding.service} observed in ${binding.datasource} as ${kind.data}=${binding.resourceId}`,
			annotations: {
				kind: "kg-binding",
				service: binding.service,
				service_normalized: serviceNormalized,
				binding_kind: kind.data,
				resource_id: binding.resourceId,
				locator: binding.locator ?? "",
				datasource: binding.datasource,
				discovered_by: "human",
				confidence: "1",
				ticket: ticketKey,
			},
		});
	}
	return true;
}

// SIO-1127: an approved heuristic becomes a kind:skill proposal fact (the SIO-1015
// pipeline), reusing buildSkillFactText/buildSkillAnnotations with learned_from:
// "ticket:<key>". Dedups by skill_name so a re-learn never doubles the immutable fact.
async function applyHeuristic(
	heuristic: Heuristic,
	ticketKey: string,
	requestId: string,
	report: HilApplyReport,
): Promise<boolean> {
	if (await skillProposalExists(heuristic.name)) {
		report.skipped.push({ id: heuristic.id, reason: `skill "${heuristic.name}" already proposed` });
		return false;
	}
	const proposal = {
		worthy: true,
		name: heuristic.name,
		description: heuristic.description,
		when_to_use: heuristic.whenToUse,
		procedure_summary: heuristic.procedure,
		task_category: "",
	};
	const nowIso = new Date().toISOString();
	recordKeyDecision({
		requestId,
		decision: buildSkillFactText(proposal),
		annotations: buildSkillAnnotations(proposal, requestId, nowIso, `ticket:${ticketKey}`),
	});
	report.heuristicsProposed += 1;
	return true;
}

// SIO-1127: open a PR-gated DRAFT runbook for a cause with no catalog match. The file is
// staged ONLY in the memory PR (never written into the runbooks dir directly -- the
// manifest loader auto-catalogs it on merge, so the PR gate is the only control). The PR
// URL lands in the apply summary; the RESOLVED_BY link is deliberately NOT written here
// (CodeRabbit PR #406) -- the runbook is not in the catalog until the PR merges.
async function draftRunbook(rc: RootCauseCorrection, ticketKey: string, report: HilApplyReport): Promise<void> {
	const filename = draftRunbookFilename(rc.causeClass);
	// severity is not on the RootCauseCorrection; the renderer defaults to "high".
	const contents = renderRunbookMarkdown(rc, ticketKey);
	try {
		const result = await promoteToMemory({
			kind: "runbook",
			branch: `agent/learn/runbook-${rc.causeClass}`,
			title: `DRAFT runbook: ${rc.causeClass} (from ${ticketKey})`,
			body: `Auto-distilled DRAFT runbook from the human resolution of ${ticketKey}. Review and edit before relying on it. Merging catalogs it for the incident-analyzer agent.`,
			files: [{ path: `${RUNBOOK_DIR}/${filename}`, contents }],
			labels: ["hil-learning", "runbook-draft"],
		});
		if (result.status === "opened" && result.url) {
			// CodeRabbit PR #406: report the PR URL but do NOT link RESOLVED_BY / write the
			// kg-resolution fact yet. The runbook file does not exist in the catalog until the
			// PR merges (and it may be rejected), so linking now would surface "resolved by
			// <draft>" on similar incidents for a runbook that isn't there. The resolution link
			// is established once the runbook is catalogued (on merge), not at draft time.
			report.draftRunbookUrl = result.url;
		} else {
			report.skipped.push({ id: rc.id, reason: `draft runbook PR not opened (${result.status})` });
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		logger.warn({ ticket: ticketKey, error: message }, "HIL draft-runbook PR failed");
		report.skipped.push({ id: rc.id, reason: "draft runbook PR failed" });
	}
}

// agent/src/learn/edits.ts
//
// SIO-1128: merge a human's per-item text edits over the distiller's proposal before
// applyLearnings writes it. Only fields in HIL_EDITABLE_FIELDS for that item's kind are
// applied -- everything else (grounded/structured fields) is ignored, so an edit cannot
// break resourceId grounding, causeClass/name regexes, or bindingKind validation. Pure:
// returns a new proposal, never mutates. A blank/whitespace edit falls back to the
// original (a cleared textarea must not erase a field).
//
// The merged output is NOT re-validated against LearningProposalSchema: safety rests
// ENTIRELY on the whitelist confining edits to unconstrained free-prose fields. If a future
// change widens HIL_EDITABLE_FIELDS to a fielded/grounded value, it MUST add re-validation
// here (or re-run verifyProposalEvidence) before applyLearnings consumes the result.

import { HIL_EDITABLE_FIELDS, type HilItemEdits, type LearningProposal } from "./schema.ts";

// Apply the whitelisted edits for one item. `item` is a plain object with string fields;
// `allowed` is the field whitelist for its kind. Returns a new item with only allowed,
// non-blank edits applied.
function editItem<T extends { id: string }>(item: T, edits: HilItemEdits, allowed: readonly string[]): T {
	const itemEdits = edits[item.id];
	if (!itemEdits) return item;
	const patch: Record<string, string> = {};
	for (const field of allowed) {
		const value = itemEdits[field];
		if (typeof value === "string" && value.trim().length > 0) patch[field] = value;
	}
	return Object.keys(patch).length > 0 ? { ...item, ...patch } : item;
}

export function applyEdits(proposal: LearningProposal, edits: HilItemEdits): LearningProposal {
	if (!edits || Object.keys(edits).length === 0) return proposal;
	return {
		...proposal,
		rootCause: proposal.rootCause
			? editItem(proposal.rootCause, edits, HIL_EDITABLE_FIELDS.rootCause)
			: proposal.rootCause,
		bindings: proposal.bindings.map((b) => editItem(b, edits, HIL_EDITABLE_FIELDS.binding)),
		heuristics: proposal.heuristics.map((h) => editItem(h, edits, HIL_EDITABLE_FIELDS.heuristic)),
		memoryFacts: proposal.memoryFacts.map((f) => editItem(f, edits, HIL_EDITABLE_FIELDS.memoryFact)),
	};
}

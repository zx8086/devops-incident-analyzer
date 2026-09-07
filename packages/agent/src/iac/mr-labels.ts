// packages/agent/src/iac/mr-labels.ts
//
// SIO-1656 (DEFECT 2026-09-07-01): the GitLab label set every agent-opened MR
// carries. The elastic-iac repo's AGENTS.md section 10 contract requires
// `agent-generated` + `iac` + EXACTLY ONE change class, applied ON THE CREATE
// CALL -- scripts/check-mr-labels.sh reads CI_MERGE_REQUEST_LABELS, which GitLab
// resolves at pipeline creation, so a label added afterwards is invisible until
// a new pipeline is created. Before this module the agent sent only the first
// two, so every config MR failed the gate and needed a manual relabel + pipeline
// re-create (MR !630; prior occurrence !600, which is why the gate exists).
//
// The mapping is DERIVED from WORKFLOW_VALUES rather than hand-maintained: a
// Record<IacWorkflow, ChangeClass> fails to compile until a newly added workflow
// is classified. That is the SIO-1003 discipline state.ts already documents --
// a hand-kept table that drifts from its enum is the bug that ticket fixed.

import type { IacWorkflow } from "./state.ts";

// The change classes scripts/check-mr-labels.sh accepts (AGENTS.md section 10).
// Retired labels the gate REJECTS: docs, drift-detection, drift-check, bugfix.
export const CHANGE_CLASSES = [
	"config-change",
	"fleet-integrations",
	"ilm",
	"drift",
	"dependencies",
	"ci",
	"tooling",
	"documentation",
	"synthetics",
] as const;

export type ChangeClass = (typeof CHANGE_CLASSES)[number];

// Which change class each IaC workflow's MR carries.
//
// Exhaustive by construction: adding a workflow to WORKFLOW_VALUES without
// classifying it here is a typecheck failure, not a silently mislabeled MR that
// only surfaces when CI rejects it.
//
// `dependencies` is deliberately unmapped -- it is Renovate-owned and the agent
// must never claim it. `ci`, `tooling` and `documentation` are likewise absent:
// the agent only edits environments/**, so no workflow can produce them.
export const WORKFLOW_CHANGE_CLASS: Record<IacWorkflow, ChangeClass> = {
	// environments/_deployments/<dep>.json and environments/<dep>/** edits.
	"version-upgrade": "config-change",
	"tier-resize": "config-change",
	"topology-edit": "config-change",
	"cluster-default-edit": "config-change",
	"cluster-default-delete": "config-change",
	"cluster-settings-edit": "config-change",
	"slo-edit": "config-change",
	"alerting-edit": "config-change",
	"dataview-edit": "config-change",
	"space-edit": "config-change",
	"security-edit": "config-change",
	"dashboard-edit": "config-change",
	"index-template-create": "config-change",
	"ingest-pipeline-create": "config-change",
	"ingest-pipeline-edit": "config-change",
	// environments/<dep>/lifecycle-policies/**.
	"ilm-rollout": "ilm",
	"ilm-delete": "ilm",
	// environments/<dep>/fleet-*/**.
	"fleet-integration": "fleet-integrations",
	// parseIntent short-circuits "other" with a capability message before any MR
	// is opened, so this is unreachable in practice; classified so the Record
	// stays exhaustive and an MR can never escape without a class.
	other: "config-change",
};

// The full label set for an MR of this change class.
//
// Section 10: a documentation-only MR carries NO `iac` label (open-mr.sh drops
// it; raw API callers must omit it). Every other class keeps the pair.
export function mrLabels(changeClass: ChangeClass): string[] {
	return changeClass === "documentation" ? ["agent-generated", changeClass] : ["agent-generated", "iac", changeClass];
}

// The change class for a parsed request. Falls back to the most common class
// rather than to a class-less set: a wrong-but-present class is a relabel, a
// missing one blocks the MR at the gate (the defect this module fixes).
export function changeClassForWorkflow(workflow: IacWorkflow | undefined): ChangeClass {
	return workflow ? WORKFLOW_CHANGE_CLASS[workflow] : "config-change";
}

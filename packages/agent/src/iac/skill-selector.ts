// agent/src/iac/skill-selector.ts
//
// SIO-1663: elastic-iac declares 16 skills and injected EVERY skill body into EVERY
// prompt on every turn. `activeSkills` has been plumbed through buildSystemPromptParts /
// buildSkillsCatalog / collectSkillToolNames since SIO-1014, honoring the local-shadows-
// shared rule, but no production call site ever passed it. This module is the missing
// half: the per-lane skill sets the IaC nodes hand to buildSystemPrompt.
//
// It deliberately does NOT key on `intent` the way SIO-1285's knowledge-selector does.
// Skills are per-WORKFLOW (19 values) while intent is a coarser 10-value enum, and 13 of
// the 16 skills fall under the single `gitops` intent -- so intent-keying would narrow
// nothing on the one lane that actually carries the skills. Instead each call site names
// the set its lane can act on, and post-parseIntent sites key on the workflow itself,
// which by then is known.
import type { LoadedAgent } from "@devops-agent/gitagent-bridge";
import type { IacWorkflow } from "./state.ts";

// The two skills that answer "what happened before" -- the only ones a read-only lane can
// act on. Both are satisfiable there: infoTools() binds the whole kg_* set plus the local
// search_memory tool, beyond the INFO_TOOL_NAMES elastic allowlist.
export const READ_ONLY_SKILLS = ["query-knowledge-graph", "search-memory"] as const;

// answerInfo additionally answers live-state questions, and validate-cluster-state is the
// skill that tells it how to read a deployment's live state. It names only elastic reads.
export const INFO_SKILLS = [...READ_ONLY_SKILLS, "validate-cluster-state"] as const;

// Every skill that is NOT lane-specific plumbing -- the floor for prompts built BEFORE the
// workflow is known. parseIntent must discriminate among 19 workflows, and each edit skill
// is what tells it that workflow exists and what inputs it takes; narrowing here would
// starve classification exactly the way narrowing knowledge-selector's `info` catch-all
// would. Pinned by skill-selector-sync.test.ts.
export const ALL_SKILLS = [
	"version-upgrade",
	"resize-tier",
	"add-ilm-policy",
	"pin-fleet-integration",
	"edit-slo",
	"edit-alert-rule",
	"edit-dataview",
	"edit-cluster-default",
	"edit-space",
	"grant-security-role",
	"edit-deployment-topology",
	"edit-dashboard",
	"open-mr",
	"validate-cluster-state",
	"query-knowledge-graph",
	"search-memory",
] as const;

// The skill that carries each workflow's procedure. Compile-time exhaustive: adding a 20th
// workflow without a mapping is a type error, and the sync test pins the reverse direction
// (nothing here that WORKFLOW_VALUES does not declare) plus on-disk existence.
//
// `null` means "no dedicated skill". Those workflows are handled by knowledge (playbook
// chapters) rather than a skill body, so there is nothing to select; the lane still gets
// the always-on plumbing skills below.
export const WORKFLOW_TO_SKILL: Record<IacWorkflow, string | null> = {
	"tier-resize": "resize-tier",
	"ilm-rollout": "add-ilm-policy",
	"ilm-delete": "add-ilm-policy",
	"version-upgrade": "version-upgrade",
	"fleet-integration": "pin-fleet-integration",
	"slo-edit": "edit-slo",
	"alerting-edit": "edit-alert-rule",
	"dataview-edit": "edit-dataview",
	"cluster-default-edit": "edit-cluster-default",
	"cluster-default-delete": "edit-cluster-default",
	"cluster-settings-edit": "edit-cluster-default",
	"space-edit": "edit-space",
	"security-edit": "grant-security-role",
	"topology-edit": "edit-deployment-topology",
	"dashboard-edit": "edit-dashboard",
	"index-template-create": "edit-cluster-default",
	"ingest-pipeline-create": null,
	"ingest-pipeline-edit": null,
	// parseIntent's catch-all. Like knowledge-selector's `info`, it is not a category of
	// request -- it is every request the classifier could not place, so it is NEVER
	// narrowed. Pinned by the sync test.
	other: null,
};

// Skills every write lane needs regardless of workflow: the live-state pre-change gate and
// the MR-opening procedure that every gitops change terminates in.
const WRITE_LANE_ALWAYS = ["validate-cluster-state", "open-mr"] as const;

// The active set for a prompt built AFTER parseIntent, when the workflow is known.
// `other` (and any workflow with no dedicated skill) falls back to the full set rather
// than to plumbing alone -- an unplaced request must not be starved.
export function skillsForWorkflow(workflow: IacWorkflow | null | undefined): string[] {
	if (!workflow) return [...ALL_SKILLS];
	const skill = WORKFLOW_TO_SKILL[workflow];
	if (!skill) return [...ALL_SKILLS];
	return [...new Set([skill, ...WRITE_LANE_ALWAYS])];
}

// buildSystemPromptParts gates LOCAL and SHARED skills on the SAME activeSkills array
// (skill-loader.ts:111 -- `activeSkills ?? [...agent.sharedSkills.keys()]`), so ANY caller
// that passes a filter silently drops every shared skill it does not name. Shared skills
// are discovered from agents/shared/ rather than declared in a manifest, so no lane set
// can name them by hand without going stale the moment one is added.
//
// withShared() re-adds whatever the agent actually loaded, keeping the monorepo-shared
// citation discipline (cite-sources) in every narrowed prompt. Verified by the
// byte-identity test: full set + shared names reproduces the unfiltered prompt exactly.
export function withShared(agent: LoadedAgent, skills: readonly string[]): string[] {
	return [...new Set([...skills, ...agent.sharedSkills.keys()])];
}

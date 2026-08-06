// src/tools/tool-classification.ts
// SIO-1417: explicit read/write/destructive classification for every tool this
// server registers, hand-reviewed against real API semantics (drafted with
// looksReadOnlyByName, then corrected -- e.g. elastic_simulate_ingest_pipeline is
// a POST but never mutates; every gitlab_trigger_* CREATES a pipeline run and is
// therefore a write even when the triggered job only reads). Annotations are
// HINTS for clients; enforcement stays in the tool surface itself (mutating
// verbs are simply not registered -- see iac.ts / server description).
import { deriveToolAnnotations } from "@devops-agent/shared";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";

const READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
	// elastic.ts -- Elastic Cloud control-plane + cluster data-plane GETs; _simulate
	// is a POST but documented read-only (validates pipeline compilation, no persistence).
	"elastic_cloud_list_deployments",
	"elastic_cloud_list_deployment_versions",
	"elastic_cloud_get_deployment",
	"elastic_cloud_get_plan_history",
	"elastic_get_cluster_health",
	"elastic_get_index_template",
	"elastic_ilm_get_lifecycle",
	"elastic_simulate_ingest_pipeline",
	// iac.ts -- read-only Task helper verbs (status/list/output/state-list).
	"iac_status",
	"iac_list_stacks",
	"iac_list_deployments",
	"iac_output",
	"iac_state_list",
	// terraform.ts -- public registry search.
	"terraform_search_modules",
	"terraform_search_providers",
	// gitlab.ts -- repo/MR/pipeline reads, including the result pollers (they poll an
	// EXISTING pipeline to terminal and fetch artifacts/traces; they never create one).
	"gitlab_get_repository_tree",
	"gitlab_get_file_content",
	"gitlab_get_merge_request",
	"gitlab_get_merge_request_pipelines",
	"gitlab_get_merge_request_approvals",
	"gitlab_get_pipeline",
	"gitlab_list_pipelines_for_sha",
	"gitlab_get_merge_commit_apply_result",
	"gitlab_get_commit_merge_requests",
	"gitlab_get_pipeline_terraform_report",
	"gitlab_get_pipeline_plan_log",
	"gitlab_get_drift_check_result",
	"gitlab_get_synthetics_drift_result",
	"gitlab_get_synthetics_push_result",
	"gitlab_get_fleet_upgrade_preview_result",
	"gitlab_get_fleet_upgrade_apply_result",
	"gitlab_list_agent_merge_requests",
]);

// Every write POSTs to GitLab: repo mutations (branch/commit/MR) or pipeline
// creation. The trigger_* tools are writes even where the triggered JOB only
// reads (drift/preview) -- creating a pipeline run is itself a side effect (it
// consumes runners and contends for the 409 lock).
const WRITE_TOOLS: ReadonlySet<string> = new Set([
	"gitlab_create_branch",
	"gitlab_commit_file",
	"gitlab_commit_files",
	"gitlab_create_merge_request",
	"gitlab_trigger_drift_check",
	"gitlab_trigger_synthetics_drift_check",
	"gitlab_trigger_synthetics_push",
	"gitlab_trigger_fleet_upgrade_preview",
	"gitlab_trigger_fleet_upgrade_apply",
]);

// Destructive per the spec's non-additive semantics: the commit tools carry
// update/delete actions (overwrite or remove existing files); synthetics_push
// re-asserts monitors onto Kibana (updates existing monitors in place); the
// fleet apply issues the bulk_upgrade POST that mutates live enrolled agents.
// Branch/MR creation and the plan-only triggers are additive, not destructive.
const DESTRUCTIVE_TOOLS: ReadonlySet<string> = new Set([
	"gitlab_commit_file",
	"gitlab_commit_files",
	"gitlab_trigger_synthetics_push",
	"gitlab_trigger_fleet_upgrade_apply",
]);

// Classification-integrity checks, fail-fast at module load.
for (const name of READ_ONLY_TOOLS) {
	if (WRITE_TOOLS.has(name)) throw new Error(`SIO-1417: "${name}" classified both read-only and write.`);
}
for (const name of DESTRUCTIVE_TOOLS) {
	if (!WRITE_TOOLS.has(name)) throw new Error(`SIO-1417: destructive "${name}" must also be in WRITE_TOOLS.`);
}

// Throws on an unclassified name, so a new tool cannot register without a
// recorded read/write decision (the konnect C-1 guard, adapted to explicit Sets).
export function iacToolAnnotations(name: string): ToolAnnotations | undefined {
	if (!READ_ONLY_TOOLS.has(name) && !WRITE_TOOLS.has(name)) {
		throw new Error(
			`SIO-1417: tool "${name}" has no read/write classification -- add it to tool-classification.ts before registering.`,
		);
	}
	return deriveToolAnnotations(name, { readOnly: READ_ONLY_TOOLS, destructive: DESTRUCTIVE_TOOLS });
}

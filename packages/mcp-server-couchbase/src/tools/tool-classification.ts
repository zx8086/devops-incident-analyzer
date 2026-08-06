// src/tools/tool-classification.ts
// SIO-1419: explicit read/write/destructive classification for every tool this
// server registers, hand-reviewed against real handler semantics. Annotations
// are HINTS for clients; enforcement stays in the handlers themselves (the
// documentation writers check their own config gates; runSqlPlusPlusQuery
// enforces readOnlyQueryMode with parser guards).
import { deriveToolAnnotations } from "@devops-agent/shared";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { config } from "../config";

const READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
	// cluster / bucket / document reads
	"capella_echo",
	"capella_ping",
	"capella_get_buckets",
	"capella_get_cluster_health",
	"capella_get_scopes_and_collections",
	"capella_get_schema_for_collection",
	"capella_get_document_by_id",
	// query analysis (system:completed_requests + system:indexes readers)
	"capella_analyze_document_structure",
	"capella_explain_sql_plus_plus_query",
	"capella_get_completed_requests",
	"capella_get_detailed_indexes",
	"capella_get_detailed_prepared_statements",
	"capella_get_document_type_examples",
	"capella_get_fatal_requests",
	"capella_get_index_advisor_recommendations",
	"capella_get_indexes_to_drop",
	"capella_get_largest_result_count_queries",
	"capella_get_largest_result_size_queries",
	"capella_get_longest_running_queries",
	"capella_get_low_selectivity_queries",
	"capella_get_most_expensive_queries",
	"capella_get_most_frequent_queries",
	"capella_get_non_covering_index_queries",
	"capella_get_prepared_statements",
	"capella_get_primary_index_queries",
	"capella_get_system_indexes",
	"capella_get_system_nodes",
	"capella_get_system_vitals",
	"capella_suggest_query_optimizations",
	// documentation / playbook reads
	"capella_get_playbook",
	"capella_list_playbooks",
	"capella_list_documentation",
	"capella_read_documentation",
]);

// Writes per the ticket's verb classes (upsert*/create*/sync* additive-or-update,
// delete* destructive). DESTRUCTIVE is a subset of WRITE (checked below).
const WRITE_TOOLS: ReadonlySet<string> = new Set([
	"capella_upsert_document_by_id",
	"capella_create_documentation",
	"capella_sync_documentation_with_database",
	"capella_delete_document_by_id",
	"capella_delete_documentation",
]);

const DESTRUCTIVE_TOOLS: ReadonlySet<string> = new Set([
	"capella_delete_document_by_id",
	"capella_delete_documentation",
]);

// capella_run_sql_plus_plus_query executes arbitrary SQL++: its read-only-ness is
// exactly config.server.readOnlyQueryMode (default true), whose parser guards
// reject DML/DDL. Annotations are registration-time hints, so derive them from
// the SAME config the handler enforces -- a boot with the mode disabled honestly
// reports a writable (and potentially destructive: arbitrary DELETE/UPDATE) tool.
const SQL_QUERY_TOOL = "capella_run_sql_plus_plus_query";

// Classification-integrity checks, fail-fast at module load.
for (const name of READ_ONLY_TOOLS) {
	if (WRITE_TOOLS.has(name)) throw new Error(`SIO-1419: "${name}" classified both read-only and write.`);
}
for (const name of DESTRUCTIVE_TOOLS) {
	if (!WRITE_TOOLS.has(name)) throw new Error(`SIO-1419: destructive "${name}" must also be in WRITE_TOOLS.`);
}

// Throws on an unclassified name, so a new tool cannot register without a
// recorded read/write decision (the konnect C-1 guard, explicit-Sets form).
export function couchbaseToolAnnotations(name: string): ToolAnnotations | undefined {
	if (name === SQL_QUERY_TOOL) {
		const readOnly = config.server.readOnlyQueryMode;
		return { readOnlyHint: readOnly, destructiveHint: !readOnly };
	}
	if (!READ_ONLY_TOOLS.has(name) && !WRITE_TOOLS.has(name)) {
		throw new Error(
			`SIO-1419: tool "${name}" has no read/write classification -- add it to tool-classification.ts before registering.`,
		);
	}
	return deriveToolAnnotations(name, { readOnly: READ_ONLY_TOOLS, destructive: DESTRUCTIVE_TOOLS });
}

/* src/tools/index.ts */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Bucket } from "couchbase";
import createDocumentation from "./createDocumentation";
import deleteDocumentation from "./deleteDocumentation";
import deleteDocumentById from "./deleteDocumentById";
import getDocumentById from "./getDocumentById";
import getSchemaForCollection from "./getSchemaForCollection";
import getScopesAndCollections from "./getScopesAndCollections";
import listDocumentation from "./listDocumentation";
import listPlaybooks from "./listPlaybooks";
// Import query analysis tools
import { queryAnalysisTools } from "./queryAnalysis";
import readDocumentation from "./readDocumentation";
import runSqlPlusPlusQuery from "./runSqlPlusPlusQuery";
import syncDocumentation from "./syncDocumentation";
import upsertDocumentById from "./upsertDocumentById";

export type ToolFunction = (server: McpServer, bucket: Bucket) => void;

// Register all documentation tools
const _registerDocumentationTools = (server: McpServer, bucket: Bucket) => {
	createDocumentation(server, bucket);
	listDocumentation(server, bucket);
	deleteDocumentation(server, bucket);
	syncDocumentation(server, bucket);
	readDocumentation(server, bucket);
};

// Register all query analysis tools
const _registerQueryAnalysisTools = (server: McpServer, bucket: Bucket) => {
	Object.values(queryAnalysisTools).forEach((tool) => tool(server, bucket));
};

// Register all playbook tools
const _registerPlaybookTools = (server: McpServer, bucket: Bucket) => {
	listPlaybooks(server, bucket);
};

export const toolRegistry: Record<string, ToolFunction> = {
	// Core database tools
	capella_get_scopes_and_collections: getScopesAndCollections,
	capella_get_schema_for_collection: getSchemaForCollection,
	capella_run_sql_plus_plus_query: runSqlPlusPlusQuery,
	capella_get_document_by_id: getDocumentById,
	capella_upsert_document_by_id: upsertDocumentById,
	capella_delete_document_by_id: deleteDocumentById,

	// Documentation tools
	capella_create_documentation: createDocumentation,
	capella_list_documentation: listDocumentation,
	capella_read_documentation: readDocumentation,
	capella_delete_documentation: deleteDocumentation,
	capella_sync_documentation_with_database: syncDocumentation,

	// Playbook tools
	capella_list_playbooks: listPlaybooks,

	// Query analysis tools
	capella_get_fatal_requests: queryAnalysisTools.getFatalRequests,
	capella_get_longest_running_queries: queryAnalysisTools.getLongestRunningQueries,
	capella_get_most_frequent_queries: queryAnalysisTools.getMostFrequentQueries,
	capella_get_largest_result_size_queries: queryAnalysisTools.getLargestResultSizeQueries,
	capella_get_largest_result_count_queries: queryAnalysisTools.getLargestResultCountQueries,
	capella_get_primary_index_queries: queryAnalysisTools.getPrimaryIndexQueries,
	capella_get_system_indexes: queryAnalysisTools.getSystemIndexes,
	capella_get_completed_requests: queryAnalysisTools.getCompletedRequests,
	capella_get_indexes_to_drop: queryAnalysisTools.getIndexesToDrop,
	capella_get_most_expensive_queries: queryAnalysisTools.getMostExpensiveQueries,
	capella_get_prepared_statements: queryAnalysisTools.getPreparedStatements,
	capella_get_document_type_examples: queryAnalysisTools.getDocumentTypeExamples,
	capella_analyze_document_structure: queryAnalysisTools.analyzeDocumentStructure,
	capella_suggest_query_optimizations: queryAnalysisTools.suggestQueryOptimizations,

	// System information tools
	capella_get_system_nodes: queryAnalysisTools.getSystemNodes,
	capella_get_system_vitals: queryAnalysisTools.getSystemVitals,
	capella_get_detailed_prepared_statements: queryAnalysisTools.getDetailedPreparedStatements,
	capella_get_detailed_indexes: queryAnalysisTools.getDetailedIndexes,
};

export default toolRegistry;

/* src/tools/index.ts */

import type { Client } from "@elastic/elasticsearch";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import {
	type CallToolResult,
	ErrorCode,
	McpError,
	type ServerNotification,
	type ServerRequest,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { runWithDeployment } from "../clients/context.js";
import { listRegisteredDeploymentIds } from "../clients/registry.js";
import { logger } from "../utils/logger.js";
import { withSecurityValidation } from "../utils/securityEnhancer.js";
import { traceToolCall } from "../utils/tracing.js";

type RegisterToolConfig = {
	title?: string;
	description?: string;
	inputSchema?: z.ZodRawShape | z.ZodObject<z.ZodRawShape> | unknown;
	[key: string]: unknown;
};

type RegisteredToolHandler = (
	toolArgs: unknown,
	extra: RequestHandlerExtra<ServerRequest, ServerNotification>,
) => Promise<CallToolResult>;

/**
 * Wrap a Zod shape (Record<string, ZodType>) in z.object() using Zod v4 classic.
 * This prevents the MCP SDK from wrapping the shape with zod/v4-mini which is
 * incompatible with Zod v4 classic schema instances.
 */
function wrapZodShape(shape: z.ZodRawShape): z.ZodObject<z.ZodRawShape> {
	return z.object(shape);
}

// SIO-675: Append an optional `deployment` field to a Zod shape so cluster tools
// can route per-call (Claude Desktop / stdio has no x-elastic-deployment header).
// Lists registered IDs in the description so the model can pick at tools/list time.
function withDeploymentField(shape: z.ZodRawShape, deploymentIds: string[]): z.ZodRawShape {
	const idList = deploymentIds.length > 0 ? deploymentIds.join(", ") : "<none registered>";
	return {
		...shape,
		deployment: z
			.string()
			.optional()
			.describe(
				`Optional. Target Elasticsearch deployment ID. One of: ${idList}. Falls back to ELASTIC_DEFAULT_DEPLOYMENT (or the x-elastic-deployment header on HTTP transport) when omitted. Explicit value wins over the header.`,
			),
	};
}

// Core Tools (List Indices, Get Mappings, Search, Get Shards)
import { registerGetMappingsTool } from "./core/get_mappings.js";
import { registerGetShardsTool } from "./core/get_shards.js";
import { registerIndicesSummaryTool } from "./core/indices_summary.js";
import { registerListIndicesTool } from "./core/list_indices.js";
import { registerSearchTool } from "./core/search.js";

// import { registerEnhancedSearchTool } from "./core/search_enhanced.js";

// Advanced Tools (Delete By Query, Translate SQL Query)
import { registerDeleteByQueryTool } from "./advanced/delete_by_query.js";
import { registerTranslateSqlQueryTool } from "./advanced/translate_sql_query.js";
// Bulk Tools (Bulk Operations, Multi Get)
import { registerBulkOperationsTool } from "./bulk/bulk_operations.js";
import { registerMultiGetTool } from "./bulk/multi_get.js";
// Document Tools (Index Document, Get Document, Update Document, Delete Document, Document Exists)
import { registerDeleteDocumentTool } from "./document/delete_document.js";
import { registerDocumentExistsTool } from "./document/document_exists.js";
import { registerGetDocumentTool } from "./document/get_document.js";
import { registerIndexDocumentTool } from "./document/index_document.js";
import { registerUpdateDocumentTool } from "./document/update_document.js";
// Index Management Tools (Create Index, Delete Index, Index Exists, Get Index, Update Index Settings, Get Index Settings, Refresh Index, Flush Index, Reindex Documents, Put Mapping)
import { registerCreateIndexTool } from "./index_management/create_index.js";
import { registerDeleteIndexTool } from "./index_management/delete_index.js";
import { registerFlushIndexTool } from "./index_management/flush_index.js";
import { registerGetIndexTool } from "./index_management/get_index.js";
import { registerGetIndexSettingsTool } from "./index_management/get_index_settings.js";
import { registerIndexExistsTool } from "./index_management/index_exists.js";
import { registerPutMappingTool } from "./index_management/put_mapping.js";
import { registerRefreshIndexTool } from "./index_management/refresh_index.js";
import { registerReindexDocumentsTool } from "./index_management/reindex_documents.js";
import { registerUpdateIndexSettingsTool } from "./index_management/update_index_settings.js";
// Search Tools (Execute SQL Query, Update By Query, Count Documents, Scroll Search, Multi Search, Clear Scroll)
import { registerClearScrollTool } from "./search/clear_scroll.js";
import { registerCountDocumentsTool } from "./search/count_documents.js";
import { registerExecuteSqlQueryTool } from "./search/execute_sql_query.js";
import { registerMultiSearchTool } from "./search/multi_search.js";
import { registerScrollSearchTool } from "./search/scroll_search.js";
import { registerUpdateByQueryTool } from "./search/update_by_query.js";

// Template Tools (Search Template, Multi Search Template, Get Index Template, Put Index Template, Delete Index Template)
import { registerDeleteIndexTemplateTool } from "./template/delete_index_template.js";
import { registerGetIndexTemplateTool } from "./template/get_index_template_improved.js";
import { registerMultiSearchTemplateTool } from "./template/multi_search_template.js";
import { registerPutIndexTemplateTool } from "./template/put_index_template.js";
import { registerSearchTemplateTool } from "./template/search_template.js";

// // Analytics Tools (Get Term Vectors, Get Multi Term Vectors, Timestamp Analysis)
// import { registerGetMultiTermVectorsTool } from "./analytics/get_multi_term_vectors.js";
// import { registerGetTermVectorsTool } from "./analytics/get_term_vectors.js";
// import { registerTimestampAnalysisTool } from "./analytics/timestamp_analysis.js";

import { registerDeleteAliasTool } from "./alias/delete_alias.js";
// Alias Tools (Get Aliases, Put Alias, Delete Alias, Update Aliases)
import { registerGetAliasesTool } from "./alias/get_aliases_improved.js";
import { registerPutAliasTool } from "./alias/put_alias.js";
import { registerUpdateAliasesTool } from "./alias/update_aliases.js";

// Cluster Tools (Get Cluster Health, Get Cluster Stats, Get Nodes Info, Get Nodes Stats)
import { registerGetClusterHealthTool } from "./cluster/get_cluster_health.js";
import { registerGetClusterStatsTool } from "./cluster/get_cluster_stats.js";
import { registerGetNodesInfoTool } from "./cluster/get_nodes_info.js";
import { registerGetNodesStatsTool } from "./cluster/get_nodes_stats.js";
// ILM Tools (Index Lifecycle Management)
import { registerDeleteLifecycleTool } from "./ilm/delete_lifecycle.js";
import { registerExplainLifecycleTool } from "./ilm/explain_lifecycle.js";
import { registerGetLifecycleTool } from "./ilm/get_lifecycle.js";
import { registerGetStatusTool } from "./ilm/get_status.js";
import { registerMigrateToDataTiersTool } from "./ilm/migrate_to_data_tiers.js";
import { registerMoveToStepTool } from "./ilm/move_to_step.js";
import { registerPutLifecycleTool } from "./ilm/put_lifecycle.js";
import { registerRemovePolicyTool } from "./ilm/remove_policy.js";
import { registerRetryTool } from "./ilm/retry.js";
import { registerStartTool } from "./ilm/start.js";
import { registerStopTool } from "./ilm/stop.js";
// Field Mapping Tools (Get Field Mapping, Clear SQL Cursor)
import { registerClearSqlCursorTool } from "./mapping/clear_sql_cursor.js";
import { registerGetFieldMappingTool } from "./mapping/get_field_mapping.js";

// // Enrich Tools (Get Policy, Put Policy, Delete Policy, Execute Policy, Stats)
// import { registerEnrichDeletePolicyTool } from "./enrich/delete_policy.js";
// import { registerEnrichExecutePolicyTool } from "./enrich/execute_policy.js";
// import { registerEnrichGetPolicyTool } from "./enrich/get_policy_improved.js";
// import { registerEnrichPutPolicyTool } from "./enrich/put_policy.js";
// import { registerEnrichStatsTool } from "./enrich/stats.js";

// // Autoscaling Tools (Get Policy, Put Policy, Delete Policy, Get Capacity)
// import { registerAutoscalingDeletePolicyTool } from "./autoscaling/delete_policy.js";
// import { registerAutoscalingGetCapacityTool } from "./autoscaling/get_capacity.js";
// import { registerAutoscalingGetPolicyTool } from "./autoscaling/get_policy.js";
// import { registerAutoscalingPutPolicyTool } from "./autoscaling/put_policy.js";

// Indices Analysis Tools (Field Usage Stats, Disk Usage, Data Lifecycle Stats, Enhanced Index Info)
import { registerDeleteDataStreamTool } from "./indices/delete_data_stream.js";
import { registerDiskUsageTool } from "./indices/disk_usage.js";
import { registerExistsAliasTool } from "./indices/exists_alias.js";
import { registerExistsIndexTemplateTool } from "./indices/exists_index_template.js";
import { registerExistsTemplateTool } from "./indices/exists_template.js";
import { registerExplainDataLifecycleTool } from "./indices/explain_data_lifecycle.js";
import { registerFieldUsageStatsTool } from "./indices/field_usage_stats.js";
import { registerGetDataLifecycleStatsTool } from "./indices/get_data_lifecycle_stats.js";
import { registerGetIndexInfoTool } from "./indices/get_index_info.js";
import { registerGetIndexSettingsAdvancedTool } from "./indices/get_index_settings_advanced.js";
import { registerRolloverTool } from "./indices/rollover.js";
// Task Tools (List Tasks, Get Task, Cancel Task)
// import { registerCancelTaskTool } from "./tasks/cancel_task.js";
import { registerGetTaskTool } from "./tasks/get_task.js";
import { registerListTasksTool } from "./tasks/list_tasks.js";

// Watcher Tools
// import {
//   registerWatcherAckWatchTool,
//   registerWatcherActivateWatchTool,
//   registerWatcherDeactivateWatchTool,
//   registerWatcherDeleteWatchTool,
//   registerWatcherExecuteWatchTool,
//   registerWatcherGetSettingsTool,
//   registerWatcherGetWatchTool,
//   registerWatcherPutWatchTool,
//   registerWatcherQueryWatchesTool,
//   registerWatcherStartTool,
//   registerWatcherStatsTool,
//   registerWatcherStopTool,
//   registerWatcherUpdateSettingsTool,
// } from "./watcher/index.js";

// Diagnostics Tools
import { registerElasticsearchDiagnostics } from "./diagnostics/index.js";
// Ingest Pipeline Tools (Get Pipeline, Put Pipeline, Delete Pipeline, Simulate Pipeline, Processor Grok)
import { registerDeleteIngestPipelineTool } from "./ingest/delete_pipeline.js";
import { registerGetIngestPipelineTool } from "./ingest/get_pipeline.js";
import { registerProcessorGrokTool } from "./ingest/processor_grok.js";
import { registerPutIngestPipelineTool } from "./ingest/put_pipeline.js";
import { registerSimulateIngestPipelineTool } from "./ingest/simulate_pipeline.js";

// Notification Tools (Progress tracking and status updates)
import { notificationTools } from "./notifications/index.js";

interface ToolInfo {
	name: string;
	description: string;
	inputSchema: z.ZodRawShape | z.ZodObject<z.ZodRawShape> | unknown;
}

// SIO-621: Read-only tools skip security-validation regex (avoid SQL-injection
// false positives on legitimate read params).
// SIO-674: Cloud / billing tools are read-only in V1 and listed alongside cluster tools.
// SIO-675 derives CLUSTER_TOOL_NAMES from this set by excluding the cloud/billing names.
const READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
	"elasticsearch_search",
	"elasticsearch_list_indices",
	"elasticsearch_get_mappings",
	"elasticsearch_get_shards",
	"elasticsearch_indices_summary",
	"elasticsearch_diagnostics",
	"elasticsearch_get_ingest_pipeline",
	"elasticsearch_simulate_ingest_pipeline",
	"elasticsearch_processor_grok",
	"elasticsearch_execute_sql_query",
	"elasticsearch_translate_sql_query",
	"elasticsearch_count_documents",
	"elasticsearch_scroll_search",
	"elasticsearch_multi_search",
	"elasticsearch_clear_scroll",
	"elasticsearch_get_cluster_health",
	"elasticsearch_get_cluster_stats",
	"elasticsearch_get_nodes_info",
	"elasticsearch_get_nodes_stats",
	"elasticsearch_get_aliases",
	"elasticsearch_get_field_mapping",
	"elasticsearch_clear_sql_cursor",
	"elasticsearch_get_document",
	"elasticsearch_document_exists",
	"elasticsearch_multi_get",
	"elasticsearch_search_template",
	"elasticsearch_multi_search_template",
	"elasticsearch_get_index_template",
	"elasticsearch_get_index",
	"elasticsearch_index_exists",
	"elasticsearch_get_index_settings",
	"elasticsearch_ilm_get_lifecycle",
	"elasticsearch_ilm_explain_lifecycle",
	"elasticsearch_ilm_get_status",
	"elasticsearch_list_tasks",
	"elasticsearch_tasks_get_task",
	"elasticsearch_field_usage_stats",
	"elasticsearch_disk_usage",
	"elasticsearch_get_data_lifecycle_stats",
	"elasticsearch_get_index_info",
	"elasticsearch_get_index_settings_advanced",
	"elasticsearch_exists_alias",
	"elasticsearch_exists_index_template",
	"elasticsearch_exists_template",
	"elasticsearch_explain_data_lifecycle",
	// SIO-674: Elastic Cloud Deployment + Billing API. Org-scoped, not cluster-scoped --
	// excluded from CLUSTER_TOOL_NAMES below because they accept their own deployment_id/org_id.
	"elasticsearch_cloud_list_deployments",
	"elasticsearch_cloud_get_deployment",
	"elasticsearch_cloud_get_plan_activity",
	"elasticsearch_cloud_get_plan_history",
	"elasticsearch_billing_get_org_costs",
	"elasticsearch_billing_get_deployment_costs",
	"elasticsearch_billing_get_org_charts",
]);

// SIO-674: Cloud / billing tools are org-scoped and already accept deployment_id / org_id
// in their own schemas. They must NOT receive the cluster `deployment` field.
const CLOUD_BILLING_TOOLS: ReadonlySet<string> = new Set([
	"elasticsearch_cloud_list_deployments",
	"elasticsearch_cloud_get_deployment",
	"elasticsearch_cloud_get_plan_activity",
	"elasticsearch_cloud_get_plan_history",
	"elasticsearch_billing_get_org_costs",
	"elasticsearch_billing_get_deployment_costs",
	"elasticsearch_billing_get_org_charts",
]);

// SIO-675: Cluster tools (ES instance-scoped) accept the optional `deployment` field
// for per-call routing. Includes read-only cluster tools AND every write tool
// (everything not in the cloud/billing set).
function isClusterTool(name: string): boolean {
	return !CLOUD_BILLING_TOOLS.has(name);
}

export function registerAllTools(server: McpServer, esClient: Client): ToolInfo[] {
	// Wrap the server to automatically add tracing to ALL tools
	// Direct server usage without wrapper

	// Track registered tools for MCP tools/list handler
	const registeredTools: ToolInfo[] = [];

	// NOTE: server.tool() wrapper removed due to MCP SDK v1.17.5 signature incompatibility
	// All tools now use server.registerTool() which has compatible wrapper below

	// Override the registerTool method to capture tool information and add both tracing and security validation
	const originalRegisterTool = server.registerTool.bind(server) as unknown as (
		name: string,
		config: RegisterToolConfig,
		handler: RegisteredToolHandler,
	) => ReturnType<McpServer["registerTool"]>;
	(server as { registerTool: unknown }).registerTool = (
		name: string,
		config: RegisterToolConfig,
		handler: RegisteredToolHandler,
	) => {
		// SIO-675: Augment cluster-tool input schemas with an optional `deployment` field
		// so Claude Desktop (stdio, no x-elastic-deployment header) can pick a deployment
		// per call. Done before the z.object() wrapping below so withDeploymentField
		// receives the raw shape. Cloud/billing tools are skipped (org-scoped already).
		const inputSchema = config.inputSchema as
			| (Record<string, unknown> & { _def?: unknown; _zod?: unknown })
			| undefined;
		if (
			isClusterTool(name) &&
			inputSchema &&
			typeof inputSchema === "object" &&
			!inputSchema._def &&
			!inputSchema._zod
		) {
			config = {
				...config,
				inputSchema: withDeploymentField(inputSchema as z.ZodRawShape, listRegisteredDeploymentIds()),
			};
		}

		// Wrap raw Zod shapes in z.object() using Zod v4 classic to prevent the
		// MCP SDK from wrapping them with zod/v4-mini (which is incompatible)
		const currentSchema = config.inputSchema as
			| (Record<string, unknown> & { _def?: unknown; _zod?: unknown })
			| undefined;
		if (currentSchema && typeof currentSchema === "object" && !currentSchema._def && !currentSchema._zod) {
			const values = Object.values(currentSchema);
			const isZodShape =
				values.length > 0 &&
				values.some(
					(v): v is z.ZodTypeAny =>
						!!v && typeof v === "object" && ("_def" in (v as object) || "_zod" in (v as object)),
				);
			if (isZodShape) {
				config = { ...config, inputSchema: wrapZodShape(currentSchema as z.ZodRawShape) };
			}
		}

		registeredTools.push({
			name,
			description: config.description || config.title || "",
			inputSchema: config.inputSchema,
		});

		const shouldValidate = !READ_ONLY_TOOLS.has(name);

		// Create enhanced handler with both tracing and security validation
		let enhancedHandler: RegisteredToolHandler = handler;

		// Add tracing wrapper to ALL tools
		enhancedHandler = async (toolArgs, extra) => {
			return traceToolCall(name, () => handler(toolArgs, extra));
		};

		// Add security validation wrapper for write operations
		if (shouldValidate) {
			enhancedHandler = withSecurityValidation<unknown, CallToolResult>(name, enhancedHandler);
		}

		// SIO-675: For cluster tools, peel off the optional `deployment` arg and route via
		// runWithDeployment(). Sits at the OUTERMOST layer so:
		//   1. The security validator never sees `deployment` (avoids regex false-positives).
		//   2. Validation of the deployment ID happens before any handler work.
		//   3. Inner runWithDeployment shadows any outer one (HTTP arg-over-header precedence).
		if (isClusterTool(name)) {
			const innerHandler = enhancedHandler;
			enhancedHandler = async (toolArgs, extra) => {
				if (
					!toolArgs ||
					typeof toolArgs !== "object" ||
					(toolArgs as Record<string, unknown>).deployment === undefined
				) {
					return innerHandler(toolArgs, extra);
				}
				const { deployment, ...rest } = toolArgs as Record<string, unknown>;
				if (typeof deployment !== "string" || deployment.length === 0) {
					const validIds = listRegisteredDeploymentIds();
					throw new McpError(
						ErrorCode.InvalidParams,
						`Invalid 'deployment' argument: expected non-empty string. Valid deployment IDs: ${validIds.join(", ") || "<none registered>"}`,
					);
				}
				const validIds = listRegisteredDeploymentIds();
				if (!validIds.includes(deployment)) {
					throw new McpError(
						ErrorCode.InvalidParams,
						`Unknown deployment '${deployment}'. Valid deployment IDs: ${validIds.join(", ") || "<none registered>"}`,
					);
				}
				return runWithDeployment(deployment, () => innerHandler(rest, extra));
			};
		}

		return originalRegisterTool(name, config, enhancedHandler);
	};

	logger.info("Registering all tools with tracing and security validation");

	// Now register all tools with the wrapped server
	// They will automatically get tracing without any changes!
	registerListIndicesTool(server, esClient);
	registerGetMappingsTool(server, esClient);
	registerSearchTool(server, esClient);
	// registerEnhancedSearchTool(server, esClient);
	registerGetShardsTool(server, esClient);
	registerIndicesSummaryTool(server, esClient);

	registerIndexDocumentTool(server, esClient);
	registerGetDocumentTool(server, esClient);
	registerUpdateDocumentTool(server, esClient);
	registerDeleteDocumentTool(server, esClient);
	registerDocumentExistsTool(server, esClient);

	registerBulkOperationsTool(server, esClient);
	registerMultiGetTool(server, esClient);

	registerExecuteSqlQueryTool(server, esClient);
	registerUpdateByQueryTool(server, esClient);
	registerCountDocumentsTool(server, esClient);
	registerScrollSearchTool(server, esClient);
	registerMultiSearchTool(server, esClient);
	registerClearScrollTool(server, esClient);

	registerCreateIndexTool(server, esClient);
	registerDeleteIndexTool(server, esClient);
	registerIndexExistsTool(server, esClient);
	registerGetIndexTool(server, esClient);
	registerUpdateIndexSettingsTool(server, esClient);
	registerGetIndexSettingsTool(server, esClient);
	registerRefreshIndexTool(server, esClient);
	registerFlushIndexTool(server, esClient);
	registerReindexDocumentsTool(server, esClient);
	registerPutMappingTool(server, esClient);

	registerDeleteByQueryTool(server, esClient);
	registerTranslateSqlQueryTool(server, esClient);

	registerSearchTemplateTool(server, esClient);
	registerMultiSearchTemplateTool(server, esClient);
	registerGetIndexTemplateTool(server, esClient);
	registerPutIndexTemplateTool(server, esClient);
	registerDeleteIndexTemplateTool(server, esClient);

	// registerGetTermVectorsTool(server, esClient);
	// registerGetMultiTermVectorsTool(server, esClient);
	// registerTimestampAnalysisTool(server, esClient);

	registerGetAliasesTool(server, esClient);
	registerPutAliasTool(server, esClient);
	registerDeleteAliasTool(server, esClient);
	registerUpdateAliasesTool(server, esClient);

	registerGetClusterHealthTool(server, esClient);
	registerGetClusterStatsTool(server, esClient);
	registerGetNodesInfoTool(server, esClient);
	registerGetNodesStatsTool(server, esClient);

	registerGetFieldMappingTool(server, esClient);
	registerClearSqlCursorTool(server, esClient);

	// Register ILM Tools
	registerDeleteLifecycleTool(server, esClient);
	registerExplainLifecycleTool(server, esClient);
	registerGetLifecycleTool(server, esClient);
	registerGetStatusTool(server, esClient);
	registerMigrateToDataTiersTool(server, esClient);
	registerMoveToStepTool(server, esClient);
	registerPutLifecycleTool(server, esClient);
	registerRemovePolicyTool(server, esClient);
	registerRetryTool(server, esClient);
	registerStartTool(server, esClient);
	registerStopTool(server, esClient);

	// // Register Enrich Tools
	// registerEnrichGetPolicyTool(server, esClient);
	// registerEnrichPutPolicyTool(server, esClient);
	// registerEnrichDeletePolicyTool(server, esClient);
	// registerEnrichExecutePolicyTool(server, esClient);
	// registerEnrichStatsTool(server, esClient);

	// // Register Autoscaling Tools
	// registerAutoscalingGetPolicyTool(server, esClient);
	// registerAutoscalingPutPolicyTool(server, esClient);
	// registerAutoscalingDeletePolicyTool(server, esClient);
	// registerAutoscalingGetCapacityTool(server, esClient);

	// Register Task Tools
	registerListTasksTool(server, esClient);
	registerGetTaskTool(server, esClient);
	// registerCancelTaskTool(server, esClient);

	// Register Indices Analysis Tools
	registerFieldUsageStatsTool(server, esClient);
	registerDiskUsageTool(server, esClient);
	registerGetDataLifecycleStatsTool(server, esClient);
	registerGetIndexInfoTool(server, esClient);
	registerGetIndexSettingsAdvancedTool(server, esClient);
	registerRolloverTool(server, esClient);
	registerExistsAliasTool(server, esClient);
	registerExistsIndexTemplateTool(server, esClient);
	registerExistsTemplateTool(server, esClient);
	registerExplainDataLifecycleTool(server, esClient);
	registerDeleteDataStreamTool(server, esClient);

	// // Register Watcher Tools
	// registerWatcherGetWatchTool(server, esClient);
	// registerWatcherPutWatchTool(server, esClient);
	// registerWatcherDeleteWatchTool(server, esClient);
	// registerWatcherQueryWatchesTool(server, esClient);
	// registerWatcherActivateWatchTool(server, esClient);
	// registerWatcherDeactivateWatchTool(server, esClient);
	// registerWatcherAckWatchTool(server, esClient);
	// registerWatcherExecuteWatchTool(server, esClient);
	// registerWatcherStartTool(server, esClient);
	// registerWatcherStopTool(server, esClient);
	// registerWatcherGetSettingsTool(server, esClient);
	// registerWatcherUpdateSettingsTool(server, esClient);
	// registerWatcherStatsTool(server, esClient);

	// Register Ingest Pipeline Tools
	registerGetIngestPipelineTool(server, esClient);
	registerPutIngestPipelineTool(server, esClient);
	registerDeleteIngestPipelineTool(server, esClient);
	registerSimulateIngestPipelineTool(server, esClient);
	registerProcessorGrokTool(server, esClient);

	// Register Diagnostics Tools
	registerElasticsearchDiagnostics(server, esClient);

	// Register Notification Tools (with progress tracking)
	for (const registerTool of notificationTools) {
		registerTool(server, esClient);
	}

	logger.debug(
		{
			toolCount: registeredTools.length,
			notificationTools: notificationTools.length,
		},
		"Tool registration details",
	);

	return registeredTools;
}

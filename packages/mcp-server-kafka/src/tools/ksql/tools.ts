// src/tools/ksql/tools.ts
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppConfig } from "../../config/schemas.ts";
import { ResponseBuilder } from "../../lib/response-builder.ts";
import type { KsqlService } from "../../services/ksql-service.ts";
import { kafkaToolAnnotations } from "../tool-classification.ts";
import { wrapHandler } from "../wrap.ts";
import * as ops from "./operations.ts";
import * as params from "./parameters.ts";
import * as prompts from "./prompts.ts";

// SIO-732: take `config` as a parameter (previously called getConfig() internally)
// so the gate around ksql_execute_statement honours the same config used elsewhere
// in registerAllTools — required for tests that drive registration with a fixture.
export function registerKsqlTools(server: McpServer, service: KsqlService, config: AppConfig): void {
	// SIO-742: reachability probes -- always registered when ksql is enabled.
	server.registerTool(
		"ksql_health_check",
		{
			description: prompts.KSQL_HEALTH_CHECK_DESCRIPTION,
			inputSchema: params.KsqlHealthCheckParams.shape,
			annotations: kafkaToolAnnotations("ksql_health_check"),
		},
		wrapHandler("ksql_health_check", config, async () => {
			const result = await ops.healthCheck(service, config);
			return ResponseBuilder.success(result);
		}),
	);

	server.registerTool(
		"ksql_cluster_status",
		{
			description: prompts.KSQL_CLUSTER_STATUS_DESCRIPTION,
			inputSchema: params.KsqlClusterStatusParams.shape,
			annotations: kafkaToolAnnotations("ksql_cluster_status"),
		},
		wrapHandler("ksql_cluster_status", config, async () => {
			const result = await ops.clusterStatus(service, config);
			return ResponseBuilder.success(result);
		}),
	);

	server.registerTool(
		"ksql_get_server_info",
		{
			description: prompts.KSQL_GET_SERVER_INFO_DESCRIPTION,
			inputSchema: params.KsqlGetServerInfoParams.shape,
			annotations: kafkaToolAnnotations("ksql_get_server_info"),
		},
		wrapHandler("ksql_get_server_info", config, async () => {
			const result = await ops.getServerInfo(service);
			return ResponseBuilder.success(result);
		}),
	);

	server.registerTool(
		"ksql_list_streams",
		{
			description: prompts.KSQL_LIST_STREAMS_DESCRIPTION,
			inputSchema: params.KsqlListStreamsParams.shape,
			annotations: kafkaToolAnnotations("ksql_list_streams"),
		},
		wrapHandler("ksql_list_streams", config, async () => {
			const result = await ops.listStreams(service);
			return ResponseBuilder.success(result);
		}),
	);

	server.registerTool(
		"ksql_list_tables",
		{
			description: prompts.KSQL_LIST_TABLES_DESCRIPTION,
			inputSchema: params.KsqlListTablesParams.shape,
			annotations: kafkaToolAnnotations("ksql_list_tables"),
		},
		wrapHandler("ksql_list_tables", config, async () => {
			const result = await ops.listTables(service);
			return ResponseBuilder.success(result);
		}),
	);

	server.registerTool(
		"ksql_list_queries",
		{
			description: prompts.KSQL_LIST_QUERIES_DESCRIPTION,
			inputSchema: params.KsqlListQueriesParams.shape,
			annotations: kafkaToolAnnotations("ksql_list_queries"),
		},
		wrapHandler("ksql_list_queries", config, async () => {
			const result = await ops.listQueries(service);
			return ResponseBuilder.success(result);
		}),
	);

	server.registerTool(
		"ksql_describe",
		{
			description: prompts.KSQL_DESCRIBE_DESCRIPTION,
			inputSchema: params.KsqlDescribeParams.shape,
			annotations: kafkaToolAnnotations("ksql_describe"),
		},
		wrapHandler("ksql_describe", config, async (args) => {
			const result = await ops.describe(service, args);
			return ResponseBuilder.success(result);
		}),
	);

	server.registerTool(
		"ksql_run_query",
		{
			description: prompts.KSQL_RUN_QUERY_DESCRIPTION,
			inputSchema: params.KsqlRunQueryParams.shape,
			annotations: kafkaToolAnnotations("ksql_run_query"),
		},
		wrapHandler("ksql_run_query", config, async (args) => {
			const result = await ops.runQuery(service, args);
			return ResponseBuilder.success(result);
		}),
	);

	// SIO-732: gate ksql_execute_statement at registration time (writes).
	// The wrap-layer check in tools/wrap.ts remains as belt-and-braces.
	if (config.kafka.allowWrites) {
		server.registerTool(
			"ksql_execute_statement",
			{
				description: prompts.KSQL_EXECUTE_STATEMENT_DESCRIPTION,
				inputSchema: params.KsqlExecuteStatementParams.shape,
				annotations: kafkaToolAnnotations("ksql_execute_statement"),
			},
			wrapHandler("ksql_execute_statement", config, async (args) => {
				const result = await ops.executeStatement(service, args);
				return ResponseBuilder.success(result);
			}),
		);
	}
}

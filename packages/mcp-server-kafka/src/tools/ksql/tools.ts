// src/tools/ksql/tools.ts
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppConfig } from "../../config/schemas.ts";
import { ResponseBuilder } from "../../lib/response-builder.ts";
import type { KsqlService } from "../../services/ksql-service.ts";
import { wrapHandler } from "../wrap.ts";
import * as ops from "./operations.ts";
import * as params from "./parameters.ts";
import * as prompts from "./prompts.ts";

// SIO-732: take `config` as a parameter (previously called getConfig() internally)
// so the gate around ksql_execute_statement honours the same config used elsewhere
// in registerAllTools — required for tests that drive registration with a fixture.
export function registerKsqlTools(server: McpServer, service: KsqlService, config: AppConfig): void {
	server.tool(
		"ksql_get_server_info",
		prompts.KSQL_GET_SERVER_INFO_DESCRIPTION,
		params.KsqlGetServerInfoParams.shape,
		wrapHandler("ksql_get_server_info", config, async () => {
			const result = await ops.getServerInfo(service);
			return ResponseBuilder.success(result);
		}),
	);

	server.tool(
		"ksql_list_streams",
		prompts.KSQL_LIST_STREAMS_DESCRIPTION,
		params.KsqlListStreamsParams.shape,
		wrapHandler("ksql_list_streams", config, async () => {
			const result = await ops.listStreams(service);
			return ResponseBuilder.success(result);
		}),
	);

	server.tool(
		"ksql_list_tables",
		prompts.KSQL_LIST_TABLES_DESCRIPTION,
		params.KsqlListTablesParams.shape,
		wrapHandler("ksql_list_tables", config, async () => {
			const result = await ops.listTables(service);
			return ResponseBuilder.success(result);
		}),
	);

	server.tool(
		"ksql_list_queries",
		prompts.KSQL_LIST_QUERIES_DESCRIPTION,
		params.KsqlListQueriesParams.shape,
		wrapHandler("ksql_list_queries", config, async () => {
			const result = await ops.listQueries(service);
			return ResponseBuilder.success(result);
		}),
	);

	server.tool(
		"ksql_describe",
		prompts.KSQL_DESCRIBE_DESCRIPTION,
		params.KsqlDescribeParams.shape,
		wrapHandler("ksql_describe", config, async (args) => {
			const result = await ops.describe(service, args);
			return ResponseBuilder.success(result);
		}),
	);

	server.tool(
		"ksql_run_query",
		prompts.KSQL_RUN_QUERY_DESCRIPTION,
		params.KsqlRunQueryParams.shape,
		wrapHandler("ksql_run_query", config, async (args) => {
			const result = await ops.runQuery(service, args);
			return ResponseBuilder.success(result);
		}),
	);

	// SIO-732: gate ksql_execute_statement at registration time (writes).
	// The wrap-layer check in tools/wrap.ts remains as belt-and-braces.
	if (config.kafka.allowWrites) {
		server.tool(
			"ksql_execute_statement",
			prompts.KSQL_EXECUTE_STATEMENT_DESCRIPTION,
			params.KsqlExecuteStatementParams.shape,
			wrapHandler("ksql_execute_statement", config, async (args) => {
				const result = await ops.executeStatement(service, args);
				return ResponseBuilder.success(result);
			}),
		);
	}
}

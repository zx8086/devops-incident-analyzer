// src/tools/logs/index.ts
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AwsConfig } from "../../config/schemas.ts";
import { toMcp } from "../wrap.ts";
import { describeLogGroups, describeLogGroupsSchema } from "./describe-log-groups.ts";
import { getQueryResults, getQueryResultsSchema } from "./get-query-results.ts";
import { startQuery, startQueryObjectSchema, startQuerySchema } from "./start-query.ts";

export function registerLogsTools(server: McpServer, config: AwsConfig): void {
	const describe = describeLogGroups(config);
	server.tool(
		"aws_logs_describe_log_groups",
		"List CloudWatch Logs log groups with optional name prefix/pattern filter.",
		describeLogGroupsSchema.shape,
		async (params) => toMcp(await describe(params)),
	);

	const start = startQuery(config);
	server.tool(
		"aws_logs_start_query",
		"Start a CloudWatch Logs Insights query. Returns a queryId for polling with aws_logs_get_query_results.",
		startQueryObjectSchema.shape,
		async (params) => toMcp(await start(params)),
	);

	const get = getQueryResults(config);
	server.tool(
		"aws_logs_get_query_results",
		"Poll a CloudWatch Logs Insights query for results. Status field indicates completion: Scheduled | Running | Complete | Failed | Cancelled | Timeout.",
		getQueryResultsSchema.shape,
		async (params) => toMcp(await get(params)),
	);
}

// Re-export schema for external consumers
export { startQuerySchema };

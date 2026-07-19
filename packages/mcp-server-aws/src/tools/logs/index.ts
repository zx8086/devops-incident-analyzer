// src/tools/logs/index.ts
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AwsConfig } from "../../config/schemas.ts";
import { withEstate } from "../estate-schema.ts";
import { toMcp } from "../wrap.ts";
import { type DescribeLogGroupsParams, describeLogGroups, describeLogGroupsSchema } from "./describe-log-groups.ts";
import { type GetLogGroupFieldsParams, getLogGroupFields, getLogGroupFieldsSchema } from "./get-log-group-fields.ts";
import { type GetQueryResultsParams, getQueryResults, getQueryResultsSchema } from "./get-query-results.ts";
import { type StartQueryParams, startQuery, startQueryObjectSchema, startQuerySchema } from "./start-query.ts";

export function registerLogsTools(server: McpServer, config: AwsConfig): void {
	const describe = describeLogGroups(config);
	server.tool(
		"aws_logs_describe_log_groups",
		"List CloudWatch Logs log groups with optional name prefix/pattern filter.",
		withEstate(config, describeLogGroupsSchema.shape),
		async (params) => toMcp(await describe(params as DescribeLogGroupsParams)),
	);

	const start = startQuery(config);
	server.tool(
		"aws_logs_start_query",
		"Start a CloudWatch Logs Insights query. Returns a queryId for polling with aws_logs_get_query_results.",
		withEstate(config, startQueryObjectSchema.shape),
		async (params) => toMcp(await start(params as StartQueryParams)),
	);

	const get = getQueryResults(config);
	server.tool(
		"aws_logs_get_query_results",
		"Poll a CloudWatch Logs Insights query for results. Status field indicates completion: Scheduled | Running | Complete | Failed | Cancelled | Timeout.",
		withEstate(config, getQueryResultsSchema.shape),
		async (params) => toMcp(await get(params as GetQueryResultsParams)),
	);

	const fields = getLogGroupFields(config);
	server.tool(
		"aws_logs_get_log_group_fields",
		"Discover which fields (including parsed JSON fields) exist in a log group's recent events, with occurrence percentage. Call BEFORE composing Logs Insights stats/filter queries on non-@ fields.",
		withEstate(config, getLogGroupFieldsSchema.shape),
		async (params) => toMcp(await fields(params as GetLogGroupFieldsParams)),
	);
}

// Re-export schema for external consumers
export { startQuerySchema };

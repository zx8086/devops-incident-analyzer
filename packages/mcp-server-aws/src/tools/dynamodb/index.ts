// src/tools/dynamodb/index.ts
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AwsConfig } from "../../config/schemas.ts";
import { toMcp } from "../wrap.ts";
import { withEstate } from "../estate-schema.ts";
import { describeTable, type DescribeTableParams, describeTableSchema } from "./describe-table.ts";
import { listTables, type ListTablesParams, listTablesSchema } from "./list-tables.ts";

export function registerDynamoDbTools(server: McpServer, config: AwsConfig): void {
	const tables = listTables(config);
	server.tool(
		"aws_dynamodb_list_tables",
		"List DynamoDB table names in the account.",
		withEstate(config, listTablesSchema.shape),
		async (params) => toMcp(await tables(params as ListTablesParams)),
	);

	const tableDetail = describeTable(config);
	server.tool(
		"aws_dynamodb_describe_table",
		"Describe a DynamoDB table including key schema, attribute definitions, indexes, provisioned throughput, and status.",
		withEstate(config, describeTableSchema.shape),
		async (params) => toMcp(await tableDetail(params as DescribeTableParams)),
	);
}

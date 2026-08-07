// src/tools/dynamodb/index.ts
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AwsConfig } from "../../config/schemas.ts";
import { AWS_READ_ONLY_ANNOTATIONS } from "../annotations.ts";
import { withEstate } from "../estate-schema.ts";
import { toMcp } from "../wrap.ts";
import { type DescribeTableParams, describeTable, describeTableSchema } from "./describe-table.ts";
import { type ListTablesParams, listTables, listTablesSchema } from "./list-tables.ts";

export function registerDynamoDbTools(server: McpServer, config: AwsConfig): void {
	const tables = listTables(config);
	server.registerTool(
		"aws_dynamodb_list_tables",
		{
			description: "List DynamoDB table names in the account.",
			inputSchema: withEstate(config, listTablesSchema.shape),
			annotations: AWS_READ_ONLY_ANNOTATIONS,
		},
		async (params) => toMcp(await tables(params as ListTablesParams)),
	);

	const tableDetail = describeTable(config);
	server.registerTool(
		"aws_dynamodb_describe_table",
		{
			description:
				"Describe a DynamoDB table including key schema, attribute definitions, indexes, provisioned throughput, and status.",
			inputSchema: withEstate(config, describeTableSchema.shape),
			annotations: AWS_READ_ONLY_ANNOTATIONS,
		},
		async (params) => toMcp(await tableDetail(params as DescribeTableParams)),
	);
}

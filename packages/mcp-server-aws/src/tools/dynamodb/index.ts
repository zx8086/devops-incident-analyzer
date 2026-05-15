// src/tools/dynamodb/index.ts
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AwsConfig } from "../../config/schemas.ts";
import { toMcp } from "../wrap.ts";
import { describeTable, describeTableSchema } from "./describe-table.ts";
import { listTables, listTablesSchema } from "./list-tables.ts";

export function registerDynamoDbTools(server: McpServer, config: AwsConfig): void {
	const tables = listTables(config);
	server.tool(
		"aws_dynamodb_list_tables",
		"List DynamoDB table names in the account.",
		listTablesSchema.shape,
		async (params) => toMcp(await tables(params)),
	);

	const tableDetail = describeTable(config);
	server.tool(
		"aws_dynamodb_describe_table",
		"Describe a DynamoDB table including key schema, attribute definitions, indexes, provisioned throughput, and status.",
		describeTableSchema.shape,
		async (params) => toMcp(await tableDetail(params)),
	);
}

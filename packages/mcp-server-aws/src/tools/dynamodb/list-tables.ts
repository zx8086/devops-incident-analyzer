// src/tools/dynamodb/list-tables.ts
import { ListTablesCommand } from "@aws-sdk/client-dynamodb";
import { z } from "zod";
import type { AwsConfig } from "../../config/schemas.ts";
import { getDynamoDbClient } from "../../services/client-factory.ts";
import type { WithEstate } from "../estate-schema.ts";
import { preferSdkParam, wrapListTool } from "../wrap.ts";

export const listTablesSchema = z.object({
	ExclusiveStartTableName: z
		.string()
		.optional()
		.describe("Pagination start key (last table name from previous response)"),
	Limit: z.number().int().optional().describe("Max tables per page (1-100). Alias: limit."),
	// SIO-838: limit alias (-> Limit). No cursor alias: ExclusiveStartTableName is a table name, not an opaque token.
	limit: z.number().int().optional().describe("Canonical page-size alias (-> Limit)."),
});

export type ListTablesParams = WithEstate<z.infer<typeof listTablesSchema>>;

export function listTables(config: AwsConfig) {
	return wrapListTool({
		name: "aws_dynamodb_list_tables",
		listField: "TableNames",
		fn: async (params: ListTablesParams) => {
			const client = getDynamoDbClient(config, params.estate);
			return client.send(
				new ListTablesCommand({
					ExclusiveStartTableName: params.ExclusiveStartTableName,
					Limit: preferSdkParam(params.Limit, params.limit),
				}),
			);
		},
	});
}

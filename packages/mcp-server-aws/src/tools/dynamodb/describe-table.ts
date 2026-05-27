// src/tools/dynamodb/describe-table.ts
import { DescribeTableCommand } from "@aws-sdk/client-dynamodb";
import { z } from "zod";
import type { AwsConfig } from "../../config/schemas.ts";
import { getDynamoDbClient } from "../../services/client-factory.ts";
import type { WithEstate } from "../estate-schema.ts";
import { wrapBlobTool } from "../wrap.ts";

export const describeTableSchema = z.object({
	TableName: z.string().describe("DynamoDB table name"),
});

export type DescribeTableParams = WithEstate<z.infer<typeof describeTableSchema>>;

export function describeTable(config: AwsConfig) {
	return wrapBlobTool({
		name: "aws_dynamodb_describe_table",
		fn: async (params: DescribeTableParams) => {
			const client = getDynamoDbClient(config, params.estate);
			return client.send(
				new DescribeTableCommand({
					TableName: params.TableName,
				}),
			);
		},
	});
}

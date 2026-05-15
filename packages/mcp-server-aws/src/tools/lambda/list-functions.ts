// src/tools/lambda/list-functions.ts
import { ListFunctionsCommand } from "@aws-sdk/client-lambda";
import { z } from "zod";
import type { AwsConfig } from "../../config/schemas.ts";
import { getLambdaClient } from "../../services/client-factory.ts";
import { wrapListTool } from "../wrap.ts";

export const listFunctionsSchema = z.object({
	MaxItems: z.number().int().optional().describe("Max functions to return (1-10000)"),
	Marker: z.string().optional().describe("Pagination marker from a previous response"),
});

export type ListFunctionsParams = z.infer<typeof listFunctionsSchema>;

export function listFunctions(config: AwsConfig) {
	return wrapListTool({
		name: "aws_lambda_list_functions",
		listField: "Functions",
		fn: async (params: ListFunctionsParams) => {
			const client = getLambdaClient(config);
			return client.send(
				new ListFunctionsCommand({
					MaxItems: params.MaxItems,
					Marker: params.Marker,
				}),
			);
		},
	});
}

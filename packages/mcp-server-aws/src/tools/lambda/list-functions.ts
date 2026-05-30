// src/tools/lambda/list-functions.ts
import { ListFunctionsCommand } from "@aws-sdk/client-lambda";
import { z } from "zod";
import type { AwsConfig } from "../../config/schemas.ts";
import { getLambdaClient } from "../../services/client-factory.ts";
import type { WithEstate } from "../estate-schema.ts";
import { preferSdkParam, wrapListTool } from "../wrap.ts";

export const listFunctionsSchema = z.object({
	MaxItems: z.number().int().optional().describe("Max functions to return (1-10000). Alias: limit."),
	Marker: z.string().optional().describe("Pagination marker from a previous response. Alias: cursor."),
	// SIO-838: canonical pagination aliases (map to MaxItems/Marker below; SDK param wins).
	limit: z.number().int().optional().describe("Canonical page-size alias (-> MaxItems)."),
	cursor: z.string().optional().describe("Canonical pagination-token alias (-> Marker). Pass _truncated.cursor here."),
});

export type ListFunctionsParams = WithEstate<z.infer<typeof listFunctionsSchema>>;

export function listFunctions(config: AwsConfig) {
	return wrapListTool({
		name: "aws_lambda_list_functions",
		listField: "Functions",
		fn: async (params: ListFunctionsParams) => {
			const client = getLambdaClient(config, params.estate);
			return client.send(
				new ListFunctionsCommand({
					MaxItems: preferSdkParam(params.MaxItems, params.limit),
					Marker: preferSdkParam(params.Marker, params.cursor),
				}),
			);
		},
	});
}

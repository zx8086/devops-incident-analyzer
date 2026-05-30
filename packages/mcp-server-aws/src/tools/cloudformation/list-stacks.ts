// src/tools/cloudformation/list-stacks.ts
import { ListStacksCommand, type StackStatus } from "@aws-sdk/client-cloudformation";
import { z } from "zod";
import type { AwsConfig } from "../../config/schemas.ts";
import { getCloudFormationClient } from "../../services/client-factory.ts";
import type { WithEstate } from "../estate-schema.ts";
import { preferSdkParam, wrapListTool } from "../wrap.ts";

export const listStacksSchema = z.object({
	StackStatusFilter: z
		.array(z.string())
		.optional()
		.describe("Filter by stack status (e.g. CREATE_COMPLETE, UPDATE_IN_PROGRESS)"),
	NextToken: z.string().optional().describe("Pagination token from a previous response. Alias: cursor."),
	// SIO-838: canonical pagination alias (map to NextToken below; SDK param wins).
	cursor: z
		.string()
		.optional()
		.describe("Canonical pagination-token alias (-> NextToken). Pass _truncated.cursor here."),
});

export type ListStacksParams = WithEstate<z.infer<typeof listStacksSchema>>;

export function listStacks(config: AwsConfig) {
	return wrapListTool({
		name: "aws_cloudformation_list_stacks",
		listField: "StackSummaries",
		fn: async (params: ListStacksParams) => {
			const client = getCloudFormationClient(config, params.estate);
			return client.send(
				new ListStacksCommand({
					StackStatusFilter: params.StackStatusFilter as StackStatus[] | undefined,
					NextToken: preferSdkParam(params.NextToken, params.cursor),
				}),
			);
		},
	});
}

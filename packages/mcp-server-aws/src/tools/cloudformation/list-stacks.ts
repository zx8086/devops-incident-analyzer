// src/tools/cloudformation/list-stacks.ts
import { ListStacksCommand, type StackStatus } from "@aws-sdk/client-cloudformation";
import { z } from "zod";
import type { AwsConfig } from "../../config/schemas.ts";
import { getCloudFormationClient } from "../../services/client-factory.ts";
import { wrapListTool } from "../wrap.ts";

export const listStacksSchema = z.object({
	StackStatusFilter: z
		.array(z.string())
		.optional()
		.describe("Filter by stack status (e.g. CREATE_COMPLETE, UPDATE_IN_PROGRESS)"),
	NextToken: z.string().optional().describe("Pagination token from a previous response"),
});

export type ListStacksParams = z.infer<typeof listStacksSchema>;

export function listStacks(config: AwsConfig) {
	return wrapListTool({
		name: "aws_cloudformation_list_stacks",
		listField: "StackSummaries",
		fn: async (params: ListStacksParams) => {
			const client = getCloudFormationClient(config);
			return client.send(
				new ListStacksCommand({
					StackStatusFilter: params.StackStatusFilter as StackStatus[] | undefined,
					NextToken: params.NextToken,
				}),
			);
		},
	});
}

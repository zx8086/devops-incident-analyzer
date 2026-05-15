// src/tools/tags/get-resources.ts
import { GetResourcesCommand } from "@aws-sdk/client-resource-groups-tagging-api";
import { z } from "zod";
import type { AwsConfig } from "../../config/schemas.ts";
import { getResourceGroupsTaggingClient } from "../../services/client-factory.ts";
import { wrapListTool } from "../wrap.ts";

export const getResourcesSchema = z.object({
	TagFilters: z
		.array(z.record(z.string(), z.unknown()))
		.optional()
		.describe("List of tag filter objects with Key and Values fields"),
	ResourcesPerPage: z.number().int().optional().describe("Max resources per page (1-100)"),
	PaginationToken: z.string().optional().describe("Pagination token from a previous response"),
});

export type GetResourcesParams = z.infer<typeof getResourcesSchema>;

export function getResources(config: AwsConfig) {
	return wrapListTool({
		name: "aws_resourcegroupstagging_get_resources",
		listField: "ResourceTagMappingList",
		fn: async (params: GetResourcesParams) => {
			const client = getResourceGroupsTaggingClient(config);
			return client.send(
				new GetResourcesCommand({
					// biome-ignore lint/suspicious/noExplicitAny: SIO-758 - TagFilter shape is complex; pass through from validated unknown
					TagFilters: params.TagFilters as any,
					ResourcesPerPage: params.ResourcesPerPage,
					PaginationToken: params.PaginationToken,
				}),
			);
		},
	});
}

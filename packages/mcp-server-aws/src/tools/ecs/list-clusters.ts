// src/tools/ecs/list-clusters.ts
import { ListClustersCommand } from "@aws-sdk/client-ecs";
import { z } from "zod";
import type { AwsConfig } from "../../config/schemas.ts";
import { getEcsClient } from "../../services/client-factory.ts";
import type { WithEstate } from "../estate-schema.ts";
import { preferSdkParam, wrapListTool } from "../wrap.ts";

export const listClustersSchema = z.object({
	maxResults: z.number().int().optional().describe("Max results per page. Alias: limit."),
	nextToken: z.string().optional().describe("Pagination token from a previous response. Alias: cursor."),
	// SIO-838: canonical pagination aliases (map to maxResults/nextToken below; SDK param wins).
	limit: z.number().int().optional().describe("Canonical page-size alias (-> maxResults)."),
	cursor: z
		.string()
		.optional()
		.describe("Canonical pagination-token alias (-> nextToken). Pass _truncated.cursor here."),
});

export type ListClustersParams = WithEstate<z.infer<typeof listClustersSchema>>;

export function listClusters(config: AwsConfig) {
	return wrapListTool({
		name: "aws_ecs_list_clusters",
		listField: "clusterArns",
		fn: async (params: ListClustersParams) => {
			const client = getEcsClient(config, params.estate);
			return client.send(
				new ListClustersCommand({
					maxResults: preferSdkParam(params.maxResults, params.limit),
					nextToken: preferSdkParam(params.nextToken, params.cursor),
				}),
			);
		},
	});
}

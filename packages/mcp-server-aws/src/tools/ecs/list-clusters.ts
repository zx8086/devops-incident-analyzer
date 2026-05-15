// src/tools/ecs/list-clusters.ts
import { ListClustersCommand } from "@aws-sdk/client-ecs";
import { z } from "zod";
import type { AwsConfig } from "../../config/schemas.ts";
import { getEcsClient } from "../../services/client-factory.ts";
import { wrapListTool } from "../wrap.ts";

export const listClustersSchema = z.object({
	maxResults: z.number().int().optional().describe("Max results per page"),
	nextToken: z.string().optional().describe("Pagination token from a previous response"),
});

export type ListClustersParams = z.infer<typeof listClustersSchema>;

export function listClusters(config: AwsConfig) {
	return wrapListTool({
		name: "aws_ecs_list_clusters",
		listField: "clusterArns",
		fn: async (params: ListClustersParams) => {
			const client = getEcsClient(config);
			return client.send(
				new ListClustersCommand({
					maxResults: params.maxResults,
					nextToken: params.nextToken,
				}),
			);
		},
	});
}

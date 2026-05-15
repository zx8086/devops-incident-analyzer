// src/tools/elasticache/describe-cache-clusters.ts
import { DescribeCacheClustersCommand } from "@aws-sdk/client-elasticache";
import { z } from "zod";
import type { AwsConfig } from "../../config/schemas.ts";
import { getElastiCacheClient } from "../../services/client-factory.ts";
import { wrapListTool } from "../wrap.ts";

export const describeCacheClustersSchema = z.object({
	CacheClusterId: z.string().optional().describe("Cache cluster ID (omit to list all)"),
	MaxRecords: z.number().int().optional().describe("Max records per page (20-100)"),
	Marker: z.string().optional().describe("Pagination marker from a previous response"),
});

export type DescribeCacheClustersParams = z.infer<typeof describeCacheClustersSchema>;

export function describeCacheClusters(config: AwsConfig) {
	return wrapListTool({
		name: "aws_elasticache_describe_cache_clusters",
		listField: "CacheClusters",
		fn: async (params: DescribeCacheClustersParams) => {
			const client = getElastiCacheClient(config);
			return client.send(
				new DescribeCacheClustersCommand({
					CacheClusterId: params.CacheClusterId,
					MaxRecords: params.MaxRecords,
					Marker: params.Marker,
				}),
			);
		},
	});
}

// src/tools/elasticache/describe-cache-clusters.ts
import { DescribeCacheClustersCommand } from "@aws-sdk/client-elasticache";
import { z } from "zod";
import type { AwsConfig } from "../../config/schemas.ts";
import { getElastiCacheClient } from "../../services/client-factory.ts";
import type { WithEstate } from "../estate-schema.ts";
import { preferSdkParam, wrapListTool } from "../wrap.ts";

export const describeCacheClustersSchema = z.object({
	CacheClusterId: z.string().optional().describe("Cache cluster ID (omit to list all)"),
	MaxRecords: z.number().int().optional().describe("Max records per page (20-100). Alias: limit."),
	Marker: z.string().optional().describe("Pagination marker from a previous response. Alias: cursor."),
	// SIO-838: canonical pagination aliases (map to MaxRecords/Marker below; SDK param wins).
	limit: z.number().int().optional().describe("Canonical page-size alias (-> MaxRecords)."),
	cursor: z.string().optional().describe("Canonical pagination-token alias (-> Marker). Pass _truncated.cursor here."),
});

export type DescribeCacheClustersParams = WithEstate<z.infer<typeof describeCacheClustersSchema>>;

export function describeCacheClusters(config: AwsConfig) {
	return wrapListTool({
		name: "aws_elasticache_describe_cache_clusters",
		listField: "CacheClusters",
		fn: async (params: DescribeCacheClustersParams) => {
			const client = getElastiCacheClient(config, params.estate);
			return client.send(
				new DescribeCacheClustersCommand({
					CacheClusterId: params.CacheClusterId,
					MaxRecords: preferSdkParam(params.MaxRecords, params.limit),
					Marker: preferSdkParam(params.Marker, params.cursor),
				}),
			);
		},
	});
}

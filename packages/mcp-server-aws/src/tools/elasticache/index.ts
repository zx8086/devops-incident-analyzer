// src/tools/elasticache/index.ts
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AwsConfig } from "../../config/schemas.ts";
import { toMcp } from "../wrap.ts";
import { withEstate } from "../estate-schema.ts";
import { describeCacheClusters, type DescribeCacheClustersParams, describeCacheClustersSchema } from "./describe-cache-clusters.ts";
import { describeReplicationGroups, type DescribeReplicationGroupsParams, describeReplicationGroupsSchema } from "./describe-replication-groups.ts";

export function registerElastiCacheTools(server: McpServer, config: AwsConfig): void {
	const cacheClusters = describeCacheClusters(config);
	server.tool(
		"aws_elasticache_describe_cache_clusters",
		"Describe ElastiCache cache clusters with engine, status, node type, and endpoint.",
		withEstate(config, describeCacheClustersSchema.shape),
		async (params) => toMcp(await cacheClusters(params as DescribeCacheClustersParams)),
	);

	const replicationGroups = describeReplicationGroups(config);
	server.tool(
		"aws_elasticache_describe_replication_groups",
		"Describe ElastiCache replication groups (Redis clusters) with status, member clusters, and configuration endpoint.",
		withEstate(config, describeReplicationGroupsSchema.shape),
		async (params) => toMcp(await replicationGroups(params as DescribeReplicationGroupsParams)),
	);
}

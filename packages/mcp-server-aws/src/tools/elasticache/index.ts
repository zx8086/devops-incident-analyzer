// src/tools/elasticache/index.ts
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AwsConfig } from "../../config/schemas.ts";
import { AWS_READ_ONLY_ANNOTATIONS } from "../annotations.ts";
import { withEstate } from "../estate-schema.ts";
import { toMcp } from "../wrap.ts";
import {
	type DescribeCacheClustersParams,
	describeCacheClusters,
	describeCacheClustersSchema,
} from "./describe-cache-clusters.ts";
import {
	type DescribeReplicationGroupsParams,
	describeReplicationGroups,
	describeReplicationGroupsSchema,
} from "./describe-replication-groups.ts";

export function registerElastiCacheTools(server: McpServer, config: AwsConfig): void {
	const cacheClusters = describeCacheClusters(config);
	server.registerTool(
		"aws_elasticache_describe_cache_clusters",
		{
			description: "Describe ElastiCache cache clusters with engine, status, node type, and endpoint.",
			inputSchema: withEstate(config, describeCacheClustersSchema.shape),
			annotations: AWS_READ_ONLY_ANNOTATIONS,
		},
		async (params) => toMcp(await cacheClusters(params as DescribeCacheClustersParams)),
	);

	const replicationGroups = describeReplicationGroups(config);
	server.registerTool(
		"aws_elasticache_describe_replication_groups",
		{
			description:
				"Describe ElastiCache replication groups (Redis clusters) with status, member clusters, and configuration endpoint.",
			inputSchema: withEstate(config, describeReplicationGroupsSchema.shape),
			annotations: AWS_READ_ONLY_ANNOTATIONS,
		},
		async (params) => toMcp(await replicationGroups(params as DescribeReplicationGroupsParams)),
	);
}

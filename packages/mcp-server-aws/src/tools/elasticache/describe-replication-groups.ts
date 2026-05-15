// src/tools/elasticache/describe-replication-groups.ts
import { DescribeReplicationGroupsCommand } from "@aws-sdk/client-elasticache";
import { z } from "zod";
import type { AwsConfig } from "../../config/schemas.ts";
import { getElastiCacheClient } from "../../services/client-factory.ts";
import { wrapListTool } from "../wrap.ts";

export const describeReplicationGroupsSchema = z.object({
	ReplicationGroupId: z.string().optional().describe("Replication group ID (omit to list all)"),
	MaxRecords: z.number().int().optional().describe("Max records per page (20-100)"),
	Marker: z.string().optional().describe("Pagination marker from a previous response"),
});

export type DescribeReplicationGroupsParams = z.infer<typeof describeReplicationGroupsSchema>;

export function describeReplicationGroups(config: AwsConfig) {
	return wrapListTool({
		name: "aws_elasticache_describe_replication_groups",
		listField: "ReplicationGroups",
		fn: async (params: DescribeReplicationGroupsParams) => {
			const client = getElastiCacheClient(config);
			return client.send(
				new DescribeReplicationGroupsCommand({
					ReplicationGroupId: params.ReplicationGroupId,
					MaxRecords: params.MaxRecords,
					Marker: params.Marker,
				}),
			);
		},
	});
}

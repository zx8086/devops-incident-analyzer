// src/tools/elasticache/describe-replication-groups.ts
import { DescribeReplicationGroupsCommand } from "@aws-sdk/client-elasticache";
import { z } from "zod";
import type { AwsConfig } from "../../config/schemas.ts";
import { getElastiCacheClient } from "../../services/client-factory.ts";
import type { WithEstate } from "../estate-schema.ts";
import { preferSdkParam, wrapListTool } from "../wrap.ts";

export const describeReplicationGroupsSchema = z.object({
	ReplicationGroupId: z.string().optional().describe("Replication group ID (omit to list all)"),
	MaxRecords: z.number().int().optional().describe("Max records per page (20-100). Alias: limit."),
	Marker: z.string().optional().describe("Pagination marker from a previous response. Alias: cursor."),
	// SIO-838: canonical pagination aliases (map to MaxRecords/Marker below; SDK param wins).
	limit: z.number().int().optional().describe("Canonical page-size alias (-> MaxRecords)."),
	cursor: z.string().optional().describe("Canonical pagination-token alias (-> Marker). Pass _truncated.cursor here."),
});

export type DescribeReplicationGroupsParams = WithEstate<z.infer<typeof describeReplicationGroupsSchema>>;

export function describeReplicationGroups(config: AwsConfig) {
	return wrapListTool({
		name: "aws_elasticache_describe_replication_groups",
		listField: "ReplicationGroups",
		fn: async (params: DescribeReplicationGroupsParams) => {
			const client = getElastiCacheClient(config, params.estate);
			return client.send(
				new DescribeReplicationGroupsCommand({
					ReplicationGroupId: params.ReplicationGroupId,
					MaxRecords: preferSdkParam(params.MaxRecords, params.limit),
					Marker: preferSdkParam(params.Marker, params.cursor),
				}),
			);
		},
	});
}

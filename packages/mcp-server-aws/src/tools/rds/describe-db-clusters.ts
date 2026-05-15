// src/tools/rds/describe-db-clusters.ts
import { DescribeDBClustersCommand } from "@aws-sdk/client-rds";
import { z } from "zod";
import type { AwsConfig } from "../../config/schemas.ts";
import { getRdsClient } from "../../services/client-factory.ts";
import { wrapListTool } from "../wrap.ts";

export const describeDbClustersSchema = z.object({
	DBClusterIdentifier: z.string().optional().describe("DB cluster identifier (omit to list all)"),
	MaxRecords: z.number().int().optional().describe("Max records per page (20-100)"),
	Marker: z.string().optional().describe("Pagination marker from a previous response"),
});

export type DescribeDbClustersParams = z.infer<typeof describeDbClustersSchema>;

export function describeDbClusters(config: AwsConfig) {
	return wrapListTool({
		name: "aws_rds_describe_db_clusters",
		listField: "DBClusters",
		fn: async (params: DescribeDbClustersParams) => {
			const client = getRdsClient(config);
			return client.send(
				new DescribeDBClustersCommand({
					DBClusterIdentifier: params.DBClusterIdentifier,
					MaxRecords: params.MaxRecords,
					Marker: params.Marker,
				}),
			);
		},
	});
}

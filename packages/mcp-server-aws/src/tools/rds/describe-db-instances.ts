// src/tools/rds/describe-db-instances.ts
import { DescribeDBInstancesCommand } from "@aws-sdk/client-rds";
import { z } from "zod";
import type { AwsConfig } from "../../config/schemas.ts";
import { getRdsClient } from "../../services/client-factory.ts";
import { wrapListTool } from "../wrap.ts";

export const describeDbInstancesSchema = z.object({
	DBInstanceIdentifier: z.string().optional().describe("DB instance identifier (omit to list all)"),
	MaxRecords: z.number().int().optional().describe("Max records per page (20-100)"),
	Marker: z.string().optional().describe("Pagination marker from a previous response"),
});

export type DescribeDbInstancesParams = z.infer<typeof describeDbInstancesSchema>;

export function describeDbInstances(config: AwsConfig) {
	return wrapListTool({
		name: "aws_rds_describe_db_instances",
		listField: "DBInstances",
		fn: async (params: DescribeDbInstancesParams) => {
			const client = getRdsClient(config);
			return client.send(
				new DescribeDBInstancesCommand({
					DBInstanceIdentifier: params.DBInstanceIdentifier,
					MaxRecords: params.MaxRecords,
					Marker: params.Marker,
				}),
			);
		},
	});
}

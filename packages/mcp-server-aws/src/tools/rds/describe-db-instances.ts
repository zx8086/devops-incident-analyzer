// src/tools/rds/describe-db-instances.ts
import { DescribeDBInstancesCommand } from "@aws-sdk/client-rds";
import { z } from "zod";
import type { AwsConfig } from "../../config/schemas.ts";
import { getRdsClient } from "../../services/client-factory.ts";
import type { WithEstate } from "../estate-schema.ts";
import { preferSdkParam, wrapListTool } from "../wrap.ts";

export const describeDbInstancesSchema = z.object({
	DBInstanceIdentifier: z.string().optional().describe("DB instance identifier (omit to list all)"),
	MaxRecords: z.number().int().optional().describe("Max records per page (20-100). Alias: limit."),
	Marker: z.string().optional().describe("Pagination marker from a previous response. Alias: cursor."),
	// SIO-838: canonical pagination aliases (map to MaxRecords/Marker below; SDK param wins).
	limit: z.number().int().optional().describe("Canonical page-size alias (-> MaxRecords)."),
	cursor: z.string().optional().describe("Canonical pagination-token alias (-> Marker). Pass _truncated.cursor here."),
});

export type DescribeDbInstancesParams = WithEstate<z.infer<typeof describeDbInstancesSchema>>;

export function describeDbInstances(config: AwsConfig) {
	return wrapListTool({
		name: "aws_rds_describe_db_instances",
		listField: "DBInstances",
		fn: async (params: DescribeDbInstancesParams) => {
			const client = getRdsClient(config, params.estate);
			return client.send(
				new DescribeDBInstancesCommand({
					DBInstanceIdentifier: params.DBInstanceIdentifier,
					MaxRecords: preferSdkParam(params.MaxRecords, params.limit),
					Marker: preferSdkParam(params.Marker, params.cursor),
				}),
			);
		},
	});
}

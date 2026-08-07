// src/tools/rds/index.ts
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AwsConfig } from "../../config/schemas.ts";
import { AWS_READ_ONLY_ANNOTATIONS } from "../annotations.ts";
import { withEstate } from "../estate-schema.ts";
import { toMcp } from "../wrap.ts";
import { type DescribeDbClustersParams, describeDbClusters, describeDbClustersSchema } from "./describe-db-clusters.ts";
import {
	type DescribeDbInstancesParams,
	describeDbInstances,
	describeDbInstancesSchema,
} from "./describe-db-instances.ts";

export function registerRdsTools(server: McpServer, config: AwsConfig): void {
	const dbInstances = describeDbInstances(config);
	server.registerTool(
		"aws_rds_describe_db_instances",
		{
			description: "Describe RDS DB instances with engine, status, endpoint, storage, and multi-AZ configuration.",
			inputSchema: withEstate(config, describeDbInstancesSchema.shape),
			annotations: AWS_READ_ONLY_ANNOTATIONS,
		},
		async (params) => toMcp(await dbInstances(params as DescribeDbInstancesParams)),
	);

	const dbClusters = describeDbClusters(config);
	server.registerTool(
		"aws_rds_describe_db_clusters",
		{
			description: "Describe RDS Aurora DB clusters with engine, status, endpoint, reader endpoint, and members.",
			inputSchema: withEstate(config, describeDbClustersSchema.shape),
			annotations: AWS_READ_ONLY_ANNOTATIONS,
		},
		async (params) => toMcp(await dbClusters(params as DescribeDbClustersParams)),
	);
}

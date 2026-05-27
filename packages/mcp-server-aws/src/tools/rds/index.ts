// src/tools/rds/index.ts
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AwsConfig } from "../../config/schemas.ts";
import { toMcp } from "../wrap.ts";
import { withEstate } from "../estate-schema.ts";
import { describeDbClusters, type DescribeDbClustersParams, describeDbClustersSchema } from "./describe-db-clusters.ts";
import { describeDbInstances, type DescribeDbInstancesParams, describeDbInstancesSchema } from "./describe-db-instances.ts";

export function registerRdsTools(server: McpServer, config: AwsConfig): void {
	const dbInstances = describeDbInstances(config);
	server.tool(
		"aws_rds_describe_db_instances",
		"Describe RDS DB instances with engine, status, endpoint, storage, and multi-AZ configuration.",
		withEstate(config, describeDbInstancesSchema.shape),
		async (params) => toMcp(await dbInstances(params as DescribeDbInstancesParams)),
	);

	const dbClusters = describeDbClusters(config);
	server.tool(
		"aws_rds_describe_db_clusters",
		"Describe RDS Aurora DB clusters with engine, status, endpoint, reader endpoint, and members.",
		withEstate(config, describeDbClustersSchema.shape),
		async (params) => toMcp(await dbClusters(params as DescribeDbClustersParams)),
	);
}

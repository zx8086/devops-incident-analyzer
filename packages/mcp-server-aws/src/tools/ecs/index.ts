// src/tools/ecs/index.ts
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AwsConfig } from "../../config/schemas.ts";
import { toMcp } from "../wrap.ts";
import { withEstate } from "../estate-schema.ts";
import { describeServices, type DescribeServicesParams, describeServicesSchema } from "./describe-services.ts";
import { describeTasks, type DescribeTasksParams, describeTasksSchema } from "./describe-tasks.ts";
import { listClusters, type ListClustersParams, listClustersSchema } from "./list-clusters.ts";
import { listTasks, type ListTasksParams, listTasksSchema } from "./list-tasks.ts";

export function registerEcsTools(server: McpServer, config: AwsConfig): void {
	const clusters = listClusters(config);
	server.tool(
		"aws_ecs_list_clusters",
		"List ECS cluster ARNs in the account.",
		withEstate(config, listClustersSchema.shape),
		async (params) => toMcp(await clusters(params as ListClustersParams)),
	);

	const services = describeServices(config);
	server.tool(
		"aws_ecs_describe_services",
		"Describe one or more ECS services in a cluster. Returns status, desired/running/pending counts, deployments.",
		withEstate(config, describeServicesSchema.shape),
		async (params) => toMcp(await services(params as DescribeServicesParams)),
	);

	const tasks = describeTasks(config);
	server.tool(
		"aws_ecs_describe_tasks",
		"Describe one or more ECS tasks. Returns task state, container statuses, last status, started/stopped times.",
		withEstate(config, describeTasksSchema.shape),
		async (params) => toMcp(await tasks(params as DescribeTasksParams)),
	);

	const taskList = listTasks(config);
	server.tool(
		"aws_ecs_list_tasks",
		"List ECS task ARNs in a cluster, optionally filtered by service or desired status.",
		withEstate(config, listTasksSchema.shape),
		async (params) => toMcp(await taskList(params as ListTasksParams)),
	);
}

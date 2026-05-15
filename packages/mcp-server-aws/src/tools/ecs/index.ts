// src/tools/ecs/index.ts
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AwsConfig } from "../../config/schemas.ts";
import { toMcp } from "../wrap.ts";
import { describeServices, describeServicesSchema } from "./describe-services.ts";
import { describeTasks, describeTasksSchema } from "./describe-tasks.ts";
import { listClusters, listClustersSchema } from "./list-clusters.ts";
import { listTasks, listTasksSchema } from "./list-tasks.ts";

export function registerEcsTools(server: McpServer, config: AwsConfig): void {
	const clusters = listClusters(config);
	server.tool(
		"aws_ecs_list_clusters",
		"List ECS cluster ARNs in the account.",
		listClustersSchema.shape,
		async (params) => toMcp(await clusters(params)),
	);

	const services = describeServices(config);
	server.tool(
		"aws_ecs_describe_services",
		"Describe one or more ECS services in a cluster. Returns status, desired/running/pending counts, deployments.",
		describeServicesSchema.shape,
		async (params) => toMcp(await services(params)),
	);

	const tasks = describeTasks(config);
	server.tool(
		"aws_ecs_describe_tasks",
		"Describe one or more ECS tasks. Returns task state, container statuses, last status, started/stopped times.",
		describeTasksSchema.shape,
		async (params) => toMcp(await tasks(params)),
	);

	const taskList = listTasks(config);
	server.tool(
		"aws_ecs_list_tasks",
		"List ECS task ARNs in a cluster, optionally filtered by service or desired status.",
		listTasksSchema.shape,
		async (params) => toMcp(await taskList(params)),
	);
}

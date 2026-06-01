// src/tools/ecs/index.ts
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AwsConfig } from "../../config/schemas.ts";
import { withEstate } from "../estate-schema.ts";
import { toMcp } from "../wrap.ts";
import { type DescribeServicesParams, describeServices, describeServicesSchema } from "./describe-services.ts";
import {
	type DescribeTaskDefinitionParams,
	describeTaskDefinition,
	describeTaskDefinitionSchema,
} from "./describe-task-definition.ts";
import { type DescribeTasksParams, describeTasks, describeTasksSchema } from "./describe-tasks.ts";
import { type ListClustersParams, listClusters, listClustersSchema } from "./list-clusters.ts";
import { type ListServicesParams, listServices, listServicesSchema } from "./list-services.ts";
import { type ListTasksParams, listTasks, listTasksSchema } from "./list-tasks.ts";

export function registerEcsTools(server: McpServer, config: AwsConfig): void {
	const clusters = listClusters(config);
	server.tool(
		"aws_ecs_list_clusters",
		"List ECS cluster ARNs in the account.",
		withEstate(config, listClustersSchema.shape),
		async (params) => toMcp(await clusters(params as ListClustersParams)),
	);

	const servicesList = listServices(config);
	server.tool(
		"aws_ecs_list_services",
		"List ECS service ARNs in a cluster. Call this BEFORE aws_ecs_describe_services to obtain the service names required by that tool.",
		withEstate(config, listServicesSchema.shape),
		async (params) => toMcp(await servicesList(params as ListServicesParams)),
	);

	const services = describeServices(config);
	server.tool(
		"aws_ecs_describe_services",
		"Describe one or more ECS services in a cluster. Returns status, desired/running/pending counts, deployments. REQUIRES service names — call aws_ecs_list_services first if you don't have them.",
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

	const taskDef = describeTaskDefinition(config);
	server.tool(
		"aws_ecs_describe_task_definition",
		"Describe an ECS task definition (family:revision or ARN, from a service's taskDefinition field). Returns containerDefinitions including environment variables and secrets references — use to confirm which datastore (RDS endpoint, etc.) a service connects to when correlating a service incident to its backend.",
		withEstate(config, describeTaskDefinitionSchema.shape),
		async (params) => toMcp(await taskDef(params as DescribeTaskDefinitionParams)),
	);

	const taskList = listTasks(config);
	server.tool(
		"aws_ecs_list_tasks",
		"List ECS task ARNs in a cluster, optionally filtered by service or desired status.",
		withEstate(config, listTasksSchema.shape),
		async (params) => toMcp(await taskList(params as ListTasksParams)),
	);
}

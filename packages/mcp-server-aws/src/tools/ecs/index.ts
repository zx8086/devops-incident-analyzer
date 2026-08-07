// src/tools/ecs/index.ts
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AwsConfig } from "../../config/schemas.ts";
import { AWS_READ_ONLY_ANNOTATIONS } from "../annotations.ts";
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
	server.registerTool(
		"aws_ecs_list_clusters",
		{
			description: "List ECS cluster ARNs in the account.",
			inputSchema: withEstate(config, listClustersSchema.shape),
			annotations: AWS_READ_ONLY_ANNOTATIONS,
		},
		async (params) => toMcp(await clusters(params as ListClustersParams)),
	);

	const servicesList = listServices(config);
	server.registerTool(
		"aws_ecs_list_services",
		{
			description:
				"List ECS service ARNs in a cluster. Call this BEFORE aws_ecs_describe_services to obtain the service names required by that tool.",
			inputSchema: withEstate(config, listServicesSchema.shape),
			annotations: AWS_READ_ONLY_ANNOTATIONS,
		},
		async (params) => toMcp(await servicesList(params as ListServicesParams)),
	);

	const services = describeServices(config);
	server.registerTool(
		"aws_ecs_describe_services",
		{
			description:
				"Describe one or more ECS services in a cluster. Returns status, desired/running/pending counts, deployments. REQUIRES service names — call aws_ecs_list_services first if you don't have them.",
			inputSchema: withEstate(config, describeServicesSchema.shape),
			annotations: AWS_READ_ONLY_ANNOTATIONS,
		},
		async (params) => toMcp(await services(params as DescribeServicesParams)),
	);

	const tasks = describeTasks(config);
	server.registerTool(
		"aws_ecs_describe_tasks",
		{
			description:
				"Describe one or more ECS tasks. Returns task state, container statuses, last status, started/stopped times.",
			inputSchema: withEstate(config, describeTasksSchema.shape),
			annotations: AWS_READ_ONLY_ANNOTATIONS,
		},
		async (params) => toMcp(await tasks(params as DescribeTasksParams)),
	);

	const taskDef = describeTaskDefinition(config);
	server.registerTool(
		"aws_ecs_describe_task_definition",
		{
			description:
				"Describe an ECS task definition (family:revision or ARN, from a service's taskDefinition field). Returns containerDefinitions including environment variables and secrets references — use to confirm which datastore (RDS endpoint, etc.) a service connects to when correlating a service incident to its backend.",
			inputSchema: withEstate(config, describeTaskDefinitionSchema.shape),
			annotations: AWS_READ_ONLY_ANNOTATIONS,
		},
		async (params) => toMcp(await taskDef(params as DescribeTaskDefinitionParams)),
	);

	const taskList = listTasks(config);
	server.registerTool(
		"aws_ecs_list_tasks",
		{
			description: "List ECS task ARNs in a cluster, optionally filtered by service or desired status.",
			inputSchema: withEstate(config, listTasksSchema.shape),
			annotations: AWS_READ_ONLY_ANNOTATIONS,
		},
		async (params) => toMcp(await taskList(params as ListTasksParams)),
	);
}

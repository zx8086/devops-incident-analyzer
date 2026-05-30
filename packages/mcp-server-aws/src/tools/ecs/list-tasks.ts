// src/tools/ecs/list-tasks.ts
import { ListTasksCommand } from "@aws-sdk/client-ecs";
import { z } from "zod";
import type { AwsConfig } from "../../config/schemas.ts";
import { getEcsClient } from "../../services/client-factory.ts";
import type { WithEstate } from "../estate-schema.ts";
import { preferSdkParam, wrapListTool } from "../wrap.ts";

export const listTasksSchema = z.object({
	cluster: z.string().describe("Short name or full ARN of the cluster"),
	serviceName: z.string().optional().describe("Filter tasks by service name"),
	desiredStatus: z.string().optional().describe("Filter by desired status: RUNNING | PENDING | STOPPED"),
	maxResults: z.number().int().optional().describe("Max results per page (1-100). Alias: limit."),
	nextToken: z.string().optional().describe("Pagination token from a previous response. Alias: cursor."),
	// SIO-838: canonical pagination aliases (map to maxResults/nextToken below; SDK param wins).
	limit: z.number().int().optional().describe("Canonical page-size alias (-> maxResults)."),
	cursor: z
		.string()
		.optional()
		.describe("Canonical pagination-token alias (-> nextToken). Pass _truncated.cursor here."),
});

export type ListTasksParams = WithEstate<z.infer<typeof listTasksSchema>>;

export function listTasks(config: AwsConfig) {
	return wrapListTool({
		name: "aws_ecs_list_tasks",
		listField: "taskArns",
		fn: async (params: ListTasksParams) => {
			const client = getEcsClient(config, params.estate);
			return client.send(
				new ListTasksCommand({
					cluster: params.cluster,
					serviceName: params.serviceName,
					desiredStatus: params.desiredStatus as "RUNNING" | "PENDING" | "STOPPED" | undefined,
					maxResults: preferSdkParam(params.maxResults, params.limit),
					nextToken: preferSdkParam(params.nextToken, params.cursor),
				}),
			);
		},
	});
}

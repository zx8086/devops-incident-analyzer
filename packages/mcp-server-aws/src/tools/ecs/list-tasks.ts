// src/tools/ecs/list-tasks.ts
import { ListTasksCommand } from "@aws-sdk/client-ecs";
import { z } from "zod";
import type { AwsConfig } from "../../config/schemas.ts";
import { getEcsClient } from "../../services/client-factory.ts";
import { wrapListTool } from "../wrap.ts";

export const listTasksSchema = z.object({
	cluster: z.string().describe("Short name or full ARN of the cluster"),
	serviceName: z.string().optional().describe("Filter tasks by service name"),
	desiredStatus: z.string().optional().describe("Filter by desired status: RUNNING | PENDING | STOPPED"),
	maxResults: z.number().int().optional().describe("Max results per page (1-100)"),
	nextToken: z.string().optional().describe("Pagination token from a previous response"),
});

export type ListTasksParams = z.infer<typeof listTasksSchema>;

export function listTasks(config: AwsConfig) {
	return wrapListTool({
		name: "aws_ecs_list_tasks",
		listField: "taskArns",
		fn: async (params: ListTasksParams) => {
			const client = getEcsClient(config);
			return client.send(
				new ListTasksCommand({
					cluster: params.cluster,
					serviceName: params.serviceName,
					desiredStatus: params.desiredStatus as "RUNNING" | "PENDING" | "STOPPED" | undefined,
					maxResults: params.maxResults,
					nextToken: params.nextToken,
				}),
			);
		},
	});
}

// src/tools/ecs/describe-tasks.ts
import { DescribeTasksCommand } from "@aws-sdk/client-ecs";
import { z } from "zod";
import type { AwsConfig } from "../../config/schemas.ts";
import { getEcsClient } from "../../services/client-factory.ts";
import { wrapListTool } from "../wrap.ts";

export const describeTasksSchema = z.object({
	cluster: z.string().describe("Short name or full ARN of the cluster"),
	tasks: z.array(z.string()).describe("List of task IDs or full ARNs to describe"),
	include: z.array(z.string()).optional().describe("Optional list of additional data to include (e.g. TAGS)"),
});

export type DescribeTasksParams = z.infer<typeof describeTasksSchema>;

export function describeTasks(config: AwsConfig) {
	return wrapListTool({
		name: "aws_ecs_describe_tasks",
		listField: "tasks",
		fn: async (params: DescribeTasksParams) => {
			const client = getEcsClient(config);
			return client.send(
				new DescribeTasksCommand({
					cluster: params.cluster,
					tasks: params.tasks,
					include: params.include as "TAGS"[] | undefined,
				}),
			);
		},
	});
}

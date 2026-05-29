// src/tools/ecs/list-services.ts
import { ListServicesCommand } from "@aws-sdk/client-ecs";
import { z } from "zod";
import type { AwsConfig } from "../../config/schemas.ts";
import { getEcsClient } from "../../services/client-factory.ts";
import type { WithEstate } from "../estate-schema.ts";
import { wrapListTool } from "../wrap.ts";

export const listServicesSchema = z.object({
	cluster: z.string().describe("Short name or full ARN of the cluster"),
	maxResults: z.number().int().min(1).max(100).optional().describe("Max results per page (1-100)"),
	nextToken: z.string().optional().describe("Pagination token from a previous response"),
	launchType: z.enum(["EC2", "FARGATE", "EXTERNAL"]).optional().describe("Filter by service launch type"),
	schedulingStrategy: z.enum(["REPLICA", "DAEMON"]).optional().describe("Filter by scheduling strategy"),
});

export type ListServicesParams = WithEstate<z.infer<typeof listServicesSchema>>;

export function listServices(config: AwsConfig) {
	return wrapListTool({
		name: "aws_ecs_list_services",
		listField: "serviceArns",
		fn: async (params: ListServicesParams) => {
			const client = getEcsClient(config, params.estate);
			return client.send(
				new ListServicesCommand({
					cluster: params.cluster,
					maxResults: params.maxResults,
					nextToken: params.nextToken,
					launchType: params.launchType,
					schedulingStrategy: params.schedulingStrategy,
				}),
			);
		},
	});
}

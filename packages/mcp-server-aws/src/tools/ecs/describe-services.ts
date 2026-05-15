// src/tools/ecs/describe-services.ts
import { DescribeServicesCommand } from "@aws-sdk/client-ecs";
import { z } from "zod";
import type { AwsConfig } from "../../config/schemas.ts";
import { getEcsClient } from "../../services/client-factory.ts";
import { wrapListTool } from "../wrap.ts";

export const describeServicesSchema = z.object({
	cluster: z.string().describe("Short name or full ARN of the cluster"),
	services: z.array(z.string()).describe("List of service names or ARNs to describe"),
	include: z.array(z.string()).optional().describe("Optional list of additional data to include (e.g. TAGS)"),
});

export type DescribeServicesParams = z.infer<typeof describeServicesSchema>;

export function describeServices(config: AwsConfig) {
	return wrapListTool({
		name: "aws_ecs_describe_services",
		listField: "services",
		fn: async (params: DescribeServicesParams) => {
			const client = getEcsClient(config);
			return client.send(
				new DescribeServicesCommand({
					cluster: params.cluster,
					services: params.services,
					include: params.include as "TAGS"[] | undefined,
				}),
			);
		},
	});
}

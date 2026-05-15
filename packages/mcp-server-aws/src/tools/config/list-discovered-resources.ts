// src/tools/config/list-discovered-resources.ts
import { ListDiscoveredResourcesCommand, type ResourceType } from "@aws-sdk/client-config-service";
import { z } from "zod";
import type { AwsConfig } from "../../config/schemas.ts";
import { getConfigServiceClient } from "../../services/client-factory.ts";
import { wrapListTool } from "../wrap.ts";

export const listDiscoveredResourcesSchema = z.object({
	resourceType: z.string().describe("AWS resource type (e.g. AWS::EC2::Instance, AWS::S3::Bucket)"),
	nextToken: z.string().optional().describe("Pagination token from a previous response"),
});

export type ListDiscoveredResourcesParams = z.infer<typeof listDiscoveredResourcesSchema>;

export function listDiscoveredResources(config: AwsConfig) {
	return wrapListTool({
		name: "aws_config_list_discovered_resources",
		listField: "resourceIdentifiers",
		fn: async (params: ListDiscoveredResourcesParams) => {
			const client = getConfigServiceClient(config);
			return client.send(
				new ListDiscoveredResourcesCommand({
					resourceType: params.resourceType as unknown as ResourceType,
					nextToken: params.nextToken,
				}),
			);
		},
	});
}

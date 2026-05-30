// src/tools/config/get-discovered-resource-counts.ts
import { GetDiscoveredResourceCountsCommand } from "@aws-sdk/client-config-service";
import { z } from "zod";
import type { AwsConfig } from "../../config/schemas.ts";
import { getConfigServiceClient } from "../../services/client-factory.ts";
import type { WithEstate } from "../estate-schema.ts";
import { wrapListTool } from "../wrap.ts";

export const getDiscoveredResourceCountsSchema = z.object({
	resourceType: z
		.string()
		.optional()
		.describe("Filter counts to one resource type (e.g. AWS::S3::Bucket); omit for all types"),
	nextToken: z.string().optional().describe("Pagination token from a previous response"),
});

export type GetDiscoveredResourceCountsParams = WithEstate<z.infer<typeof getDiscoveredResourceCountsSchema>>;

// SIO-834: account-wide resource inventory in one call (per-type counts, no resourceType
// required) so the sub-agent can characterize a governance/landing-zone estate that runs no
// workloads instead of reporting "no compute" when the workload probes come back empty.
export function getDiscoveredResourceCounts(config: AwsConfig) {
	return wrapListTool({
		name: "aws_config_get_discovered_resource_counts",
		listField: "resourceCounts",
		fn: async (params: GetDiscoveredResourceCountsParams) => {
			const client = getConfigServiceClient(config, params.estate);
			return client.send(
				new GetDiscoveredResourceCountsCommand({
					resourceTypes: params.resourceType ? [params.resourceType] : undefined,
					nextToken: params.nextToken,
				}),
			);
		},
	});
}

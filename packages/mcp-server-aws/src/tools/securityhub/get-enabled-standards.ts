// src/tools/securityhub/get-enabled-standards.ts
import { GetEnabledStandardsCommand } from "@aws-sdk/client-securityhub";
import { z } from "zod";
import type { AwsConfig } from "../../config/schemas.ts";
import { getSecurityHubClient } from "../../services/client-factory.ts";
import type { WithEstate } from "../estate-schema.ts";
import { wrapListTool } from "../wrap.ts";

export const getEnabledStandardsSchema = z.object({
	StandardsSubscriptionArns: z
		.array(z.string())
		.optional()
		.describe("Filter to specific subscription ARNs (omit to list all enabled standards)"),
	NextToken: z.string().optional().describe("Pagination token from a previous response"),
});

export type GetEnabledStandardsParams = WithEstate<z.infer<typeof getEnabledStandardsSchema>>;

export function getEnabledStandards(config: AwsConfig) {
	return wrapListTool({
		name: "aws_securityhub_get_enabled_standards",
		listField: "StandardsSubscriptions",
		fn: async (params: GetEnabledStandardsParams) => {
			const client = getSecurityHubClient(config, params.estate);
			return client.send(
				new GetEnabledStandardsCommand({
					StandardsSubscriptionArns: params.StandardsSubscriptionArns,
					NextToken: params.NextToken,
				}),
			);
		},
	});
}

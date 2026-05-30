// src/tools/cloudtrail/describe-trails.ts
import { DescribeTrailsCommand } from "@aws-sdk/client-cloudtrail";
import { z } from "zod";
import type { AwsConfig } from "../../config/schemas.ts";
import { getCloudTrailClient } from "../../services/client-factory.ts";
import type { WithEstate } from "../estate-schema.ts";
import { wrapListTool } from "../wrap.ts";

export const describeTrailsSchema = z.object({
	trailNameList: z
		.array(z.string())
		.optional()
		.describe("Trail names or ARNs to describe (omit to describe all trails in the account/region)"),
	includeShadowTrails: z
		.boolean()
		.optional()
		.describe("Include shadow trails (multi-region/org trails replicated into this region)"),
});

export type DescribeTrailsParams = WithEstate<z.infer<typeof describeTrailsSchema>>;

export function describeTrails(config: AwsConfig) {
	return wrapListTool({
		name: "aws_cloudtrail_describe_trails",
		listField: "trailList",
		fn: async (params: DescribeTrailsParams) => {
			const client = getCloudTrailClient(config, params.estate);
			return client.send(
				new DescribeTrailsCommand({
					trailNameList: params.trailNameList,
					includeShadowTrails: params.includeShadowTrails,
				}),
			);
		},
	});
}

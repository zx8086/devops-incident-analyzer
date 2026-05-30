// src/tools/cloudtrail/list-trails.ts
import { ListTrailsCommand } from "@aws-sdk/client-cloudtrail";
import { z } from "zod";
import type { AwsConfig } from "../../config/schemas.ts";
import { getCloudTrailClient } from "../../services/client-factory.ts";
import type { WithEstate } from "../estate-schema.ts";
import { preferSdkParam, wrapListTool } from "../wrap.ts";

export const listTrailsSchema = z.object({
	NextToken: z.string().optional().describe("Pagination token from a previous response. Alias: cursor."),
	// SIO-838: canonical pagination alias (map to NextToken below; SDK param wins).
	cursor: z
		.string()
		.optional()
		.describe("Canonical pagination-token alias (-> NextToken). Pass _truncated.cursor here."),
});

export type ListTrailsParams = WithEstate<z.infer<typeof listTrailsSchema>>;

export function listTrails(config: AwsConfig) {
	return wrapListTool({
		name: "aws_cloudtrail_list_trails",
		listField: "Trails",
		fn: async (params: ListTrailsParams) => {
			const client = getCloudTrailClient(config, params.estate);
			return client.send(new ListTrailsCommand({ NextToken: preferSdkParam(params.NextToken, params.cursor) }));
		},
	});
}

// src/tools/health/describe-events.ts
import { DescribeEventsCommand } from "@aws-sdk/client-health";
import { z } from "zod";
import type { AwsConfig } from "../../config/schemas.ts";
import { getHealthClient } from "../../services/client-factory.ts";
import type { WithEstate } from "../estate-schema.ts";
import { preferSdkParam, wrapListTool } from "../wrap.ts";

export const describeEventsSchema = z.object({
	filter: z
		.record(z.string(), z.unknown())
		.optional()
		.describe("Filter criteria for events (services, regions, eventTypeCategories, etc.)"),
	maxResults: z.number().int().optional().describe("Max results per page (1-100). Alias: limit."),
	nextToken: z.string().optional().describe("Pagination token from a previous response. Alias: cursor."),
	// SIO-838: canonical pagination aliases (-> maxResults / nextToken; SDK param wins).
	limit: z.number().int().optional().describe("Canonical page-size alias (-> maxResults)."),
	cursor: z
		.string()
		.optional()
		.describe("Canonical pagination-token alias (-> nextToken). Pass _truncated.cursor here."),
});

export type DescribeEventsParams = WithEstate<z.infer<typeof describeEventsSchema>>;

export function describeEvents(config: AwsConfig) {
	return wrapListTool({
		name: "aws_health_describe_events",
		listField: "events",
		fn: async (params: DescribeEventsParams) => {
			const client = getHealthClient(config, params.estate);
			return client.send(
				new DescribeEventsCommand({
					// biome-ignore lint/suspicious/noExplicitAny: SIO-758 - Health filter shape is complex nested object; pass through from validated unknown
					filter: params.filter as any,
					maxResults: preferSdkParam(params.maxResults, params.limit),
					nextToken: preferSdkParam(params.nextToken, params.cursor),
				}),
			);
		},
	});
}

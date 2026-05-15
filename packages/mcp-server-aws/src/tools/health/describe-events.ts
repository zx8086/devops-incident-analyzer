// src/tools/health/describe-events.ts
import { DescribeEventsCommand } from "@aws-sdk/client-health";
import { z } from "zod";
import type { AwsConfig } from "../../config/schemas.ts";
import { getHealthClient } from "../../services/client-factory.ts";
import { wrapListTool } from "../wrap.ts";

export const describeEventsSchema = z.object({
	filter: z
		.record(z.string(), z.unknown())
		.optional()
		.describe("Filter criteria for events (services, regions, eventTypeCategories, etc.)"),
	maxResults: z.number().int().optional().describe("Max results per page (1-100)"),
	nextToken: z.string().optional().describe("Pagination token from a previous response"),
});

export type DescribeEventsParams = z.infer<typeof describeEventsSchema>;

export function describeEvents(config: AwsConfig) {
	return wrapListTool({
		name: "aws_health_describe_events",
		listField: "events",
		fn: async (params: DescribeEventsParams) => {
			const client = getHealthClient(config);
			return client.send(
				new DescribeEventsCommand({
					// biome-ignore lint/suspicious/noExplicitAny: SIO-758 - Health filter shape is complex nested object; pass through from validated unknown
					filter: params.filter as any,
					maxResults: params.maxResults,
					nextToken: params.nextToken,
				}),
			);
		},
	});
}

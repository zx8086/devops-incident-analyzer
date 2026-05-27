// src/tools/xray/get-trace-summaries.ts
import { GetTraceSummariesCommand } from "@aws-sdk/client-xray";
import { z } from "zod";
import type { AwsConfig } from "../../config/schemas.ts";
import { getXrayClient } from "../../services/client-factory.ts";
import type { WithEstate } from "../estate-schema.ts";
import { wrapListTool } from "../wrap.ts";

export const getTraceSummariesSchema = z.object({
	StartTime: z.string().describe("ISO 8601 start time for trace summaries"),
	EndTime: z.string().describe("ISO 8601 end time for trace summaries"),
});

export type GetTraceSummariesParams = WithEstate<z.infer<typeof getTraceSummariesSchema>>;

export function getTraceSummaries(config: AwsConfig) {
	return wrapListTool({
		name: "aws_xray_get_trace_summaries",
		listField: "TraceSummaries",
		fn: async (params: GetTraceSummariesParams) => {
			const client = getXrayClient(config, params.estate);
			return client.send(
				new GetTraceSummariesCommand({
					StartTime: new Date(params.StartTime),
					EndTime: new Date(params.EndTime),
				}),
			);
		},
	});
}

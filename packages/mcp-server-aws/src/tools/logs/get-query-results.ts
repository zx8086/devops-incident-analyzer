// src/tools/logs/get-query-results.ts
import { GetQueryResultsCommand } from "@aws-sdk/client-cloudwatch-logs";
import { z } from "zod";
import type { AwsConfig } from "../../config/schemas.ts";
import { getCloudWatchLogsClient } from "../../services/client-factory.ts";
import { wrapListTool } from "../wrap.ts";

export const getQueryResultsSchema = z.object({
	queryId: z.string().min(1).describe("Query ID returned by aws_logs_start_query"),
});

export type GetQueryResultsParams = z.infer<typeof getQueryResultsSchema>;

export function getQueryResults(config: AwsConfig) {
	return wrapListTool({
		name: "aws_logs_get_query_results",
		listField: "results",
		fn: async (params: GetQueryResultsParams) => {
			const client = getCloudWatchLogsClient(config);
			return client.send(new GetQueryResultsCommand({ queryId: params.queryId }));
		},
	});
}

// src/tools/logs/start-query.ts
import { StartQueryCommand } from "@aws-sdk/client-cloudwatch-logs";
import { z } from "zod";
import type { AwsConfig } from "../../config/schemas.ts";
import { getCloudWatchLogsClient } from "../../services/client-factory.ts";
import { wrapBlobTool } from "../wrap.ts";

export const startQueryObjectSchema = z.object({
	logGroupNames: z
		.array(z.string())
		.min(1)
		.optional()
		.describe("Names of log groups to query (1+). Mutually exclusive with logGroupIdentifiers."),
	logGroupIdentifiers: z
		.array(z.string())
		.min(1)
		.optional()
		.describe("ARNs of log groups to query, including cross-account. Mutually exclusive with logGroupNames."),
	queryString: z.string().min(1).describe("CloudWatch Logs Insights query string"),
	startTime: z.number().int().describe("Query window start (Unix epoch seconds)"),
	endTime: z.number().int().describe("Query window end (Unix epoch seconds)"),
	limit: z.number().int().min(1).max(10000).optional().describe("Max rows to return (1-10000)"),
});

export const startQuerySchema = startQueryObjectSchema.refine(
	(v) => (v.logGroupNames !== undefined) !== (v.logGroupIdentifiers !== undefined),
	"Provide exactly one of logGroupNames or logGroupIdentifiers",
);

export type StartQueryParams = z.infer<typeof startQueryObjectSchema>;

export function startQuery(config: AwsConfig) {
	return wrapBlobTool({
		name: "aws_logs_start_query",
		fn: async (params: StartQueryParams) => {
			const client = getCloudWatchLogsClient(config);
			return client.send(
				new StartQueryCommand({
					logGroupNames: params.logGroupNames,
					logGroupIdentifiers: params.logGroupIdentifiers,
					queryString: params.queryString,
					startTime: params.startTime,
					endTime: params.endTime,
					limit: params.limit,
				}),
			);
		},
	});
}

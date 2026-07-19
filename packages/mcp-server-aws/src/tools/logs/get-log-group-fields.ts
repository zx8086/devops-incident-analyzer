// src/tools/logs/get-log-group-fields.ts
import { GetLogGroupFieldsCommand } from "@aws-sdk/client-cloudwatch-logs";
import { z } from "zod";
import type { AwsConfig } from "../../config/schemas.ts";
import { getCloudWatchLogsClient } from "../../services/client-factory.ts";
import type { WithEstate } from "../estate-schema.ts";
import { wrapListTool } from "../wrap.ts";
import { parseRelative } from "./start-query.ts";

// SIO-1161: field discovery before composing Logs Insights stats/filter queries on non-@ fields.
// Prevents the unknown-field empty-result loop: a query on a guessed field name returns zero rows
// with no error, which reads as "no logs" when the field simply is not called that.
export const getLogGroupFieldsSchema = z.object({
	logGroupName: z
		.string()
		.min(1)
		.describe("Exact log group name (resolve it first via aws_logs_describe_log_groups; never guess)."),
	atRelative: z
		.string()
		// Reject a malformed token at the schema layer -- omitting `time` on a bad token would
		// silently search the most recent 15 minutes instead of the requested incident window.
		.refine((value) => parseRelative(value, 0) !== null, {
			message: 'Use "now" or "now-<n><unit>" where unit is s/m/h/d/w (e.g. "now-1h").',
		})
		.optional()
		.describe(
			'Center of the ~16-minute discovery window, RELATIVE to now (e.g. "now-1h"). Format "now" or "now-<n><unit>", unit s/m/h/d/w. Omit to search the most recent 15 minutes.',
		),
});

export type GetLogGroupFieldsParams = WithEstate<z.infer<typeof getLogGroupFieldsSchema>>;

export function getLogGroupFields(config: AwsConfig) {
	return wrapListTool({
		name: "aws_logs_get_log_group_fields",
		listField: "logGroupFields",
		fn: async (params: GetLogGroupFieldsParams) => {
			const nowSeconds = Math.floor(Date.now() / 1000);
			// GetLogGroupFields `time` is epoch SECONDS; searches 8 minutes either side of it.
			const at = params.atRelative !== undefined ? parseRelative(params.atRelative, nowSeconds) : null;
			const client = getCloudWatchLogsClient(config, params.estate);
			return client.send(
				new GetLogGroupFieldsCommand({
					logGroupName: params.logGroupName,
					...(at !== null ? { time: at } : {}),
				}),
			);
		},
	});
}

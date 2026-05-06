// src/tools/billing/get_org_charts.ts

import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { CloudClient } from "../../clients/cloudClient.js";
import { logger } from "../../utils/logger.js";
import type { CloudToolRegistrationFunction, SearchResult, TextContent } from "../types.js";

const TOOL_NAME = "elasticsearch_billing_get_org_charts";

const validator = z.object({
	org_id: z.string().min(1).optional(),
	from: z.string().min(1).optional(),
	to: z.string().min(1).optional(),
	bucketing_strategy: z.enum(["hourly", "daily", "monthly"]).optional(),
});

type Params = z.infer<typeof validator>;

export const registerBillingGetOrgChartsTool: CloudToolRegistrationFunction = (server, cloudClient: CloudClient) => {
	const handler = async (args: Params): Promise<SearchResult> => {
		const requestId = Math.random().toString(36).substring(7);
		try {
			const params = validator.parse(args);
			const orgId = params.org_id ?? cloudClient.defaultOrgId;
			if (!orgId) {
				throw new McpError(
					ErrorCode.InvalidParams,
					`[${TOOL_NAME}] org_id is required when EC_DEFAULT_ORG_ID is not set`,
				);
			}
			logger.info(
				{
					requestId,
					orgId,
					from: params.from,
					to: params.to,
					bucketingStrategy: params.bucketing_strategy,
				},
				`[${TOOL_NAME}] fetching org cost charts`,
			);
			const result = await cloudClient.get(`/api/v1/billing/costs/organizations/${encodeURIComponent(orgId)}/charts`, {
				query: {
					from: params.from,
					to: params.to,
					bucketing_strategy: params.bucketing_strategy,
				},
			});
			return {
				content: [{ type: "text", text: JSON.stringify(result, null, 2) } as TextContent],
			};
		} catch (error) {
			if (error instanceof McpError) throw error;
			if (error instanceof z.ZodError) {
				throw new McpError(ErrorCode.InvalidParams, `[${TOOL_NAME}] Validation failed`, { issues: error.issues });
			}
			logger.error(
				{ requestId, error: error instanceof Error ? error.message : String(error) },
				`[${TOOL_NAME}] failed`,
			);
			throw new McpError(
				ErrorCode.InternalError,
				`[${TOOL_NAME}] ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	};

	server.registerTool(
		TOOL_NAME,
		{
			title: "Elastic Cloud Billing: org cost time-series",
			description:
				"Elastic Cloud Billing Costs Analysis API -- time-series cost data for charts and dashboards, bucketed hourly/daily/monthly. Use for quarterly trend analysis and value tracking against optimisation programmes. org_id falls back to EC_DEFAULT_ORG_ID. from/to are ISO 8601. READ operation.",
			inputSchema: validator.shape,
		},
		handler,
	);
};

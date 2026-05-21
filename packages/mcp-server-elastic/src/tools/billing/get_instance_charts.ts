// src/tools/billing/get_instance_charts.ts

import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { CloudClient } from "../../clients/cloudClient.js";
import { logger } from "../../utils/logger.js";
import type { CloudToolRegistrationFunction, SearchResult, TextContent } from "../types.js";

const TOOL_NAME = "elasticsearch_billing_get_instance_charts";

const validator = z.object({
	instance_id: z.string().min(1),
	org_id: z.string().min(1).optional(),
	from: z.string().min(1),
	to: z.string().min(1),
	bucketing_strategy: z.enum(["daily", "monthly"]).optional(),
	instance_type: z.enum(["all", "deployments", "projects"]).optional(),
});

type Params = z.infer<typeof validator>;

export const registerBillingGetInstanceChartsTool: CloudToolRegistrationFunction = (
	server,
	cloudClient: CloudClient,
) => {
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
					instanceId: params.instance_id,
					from: params.from,
					to: params.to,
					bucketingStrategy: params.bucketing_strategy,
				},
				`[${TOOL_NAME}] fetching instance cost charts`,
			);
			const result = await cloudClient.get(
				`/api/v2/billing/organizations/${encodeURIComponent(orgId)}/instances/${encodeURIComponent(params.instance_id)}/charts`,
				{
					query: {
						from: params.from,
						to: params.to,
						bucketing_strategy: params.bucketing_strategy,
						instance_type: params.instance_type,
					},
				},
			);
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
			title: "Elastic Cloud Billing: per-instance cost time-series",
			description:
				"Elastic Cloud Billing Charts API (v2) -- time-series cost data for a single instance, bucketed daily or monthly. Use this -- not billing_get_deployment_costs (which filters the org-wide chart) -- when you need authoritative per-deployment trend data without client-side reconciliation. Discover the instance_id from billing_list_instances. org_id falls back to EC_DEFAULT_ORG_ID. from/to are required ISO 8601 timestamps. bucketing_strategy must be 'daily' or 'monthly'. instance_type filters to 'deployments' / 'projects' / 'all'. READ operation.",
			inputSchema: validator.shape,
		},
		handler,
	);
};

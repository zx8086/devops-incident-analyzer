// src/tools/billing/get_org_costs.ts

import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { CloudClient } from "../../clients/cloudClient.js";
import { logger } from "../../utils/logger.js";
import type { CloudToolRegistrationFunction, SearchResult, TextContent } from "../types.js";

const TOOL_NAME = "elasticsearch_billing_get_org_costs";

const validator = z.object({
	org_id: z.string().min(1).optional(),
	from: z.string().min(1).optional(),
	to: z.string().min(1).optional(),
});

type Params = z.infer<typeof validator>;

export const registerBillingGetOrgCostsTool: CloudToolRegistrationFunction = (server, cloudClient: CloudClient) => {
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
			logger.info({ requestId, orgId, from: params.from, to: params.to }, `[${TOOL_NAME}] fetching org costs`);
			const result = await cloudClient.get(`/api/v1/billing/costs/organizations/${encodeURIComponent(orgId)}/items`, {
				query: { from: params.from, to: params.to },
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
			title: "Elastic Cloud Billing: itemised org costs",
			description:
				"Elastic Cloud Billing Costs Analysis API -- itemised costs for the configured organisation, broken down by billing dimension (capacity, data_in, data_internode, data_out, storage_api, storage_bytes). Each item includes hours, instance_count, period, kind, price, and price_per_hour in ECU. Use to confirm realised hourly rate after plan changes (e.g. cold tier downsize). org_id falls back to EC_DEFAULT_ORG_ID. from/to are ISO 8601. READ operation.",
			inputSchema: validator.shape,
		},
		handler,
	);
};

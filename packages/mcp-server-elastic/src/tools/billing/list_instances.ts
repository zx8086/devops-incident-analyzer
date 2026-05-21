// src/tools/billing/list_instances.ts

import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { CloudClient } from "../../clients/cloudClient.js";
import { logger } from "../../utils/logger.js";
import type { CloudToolRegistrationFunction, SearchResult, TextContent } from "../types.js";

const TOOL_NAME = "elasticsearch_billing_list_instances";

const validator = z.object({
	org_id: z.string().min(1).optional(),
	from: z.string().min(1),
	to: z.string().min(1),
	include_names: z.boolean().optional(),
});

type Params = z.infer<typeof validator>;

export const registerBillingListInstancesTool: CloudToolRegistrationFunction = (server, cloudClient: CloudClient) => {
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
				{ requestId, orgId, from: params.from, to: params.to, includeNames: params.include_names },
				`[${TOOL_NAME}] listing instances with costs`,
			);
			const result = await cloudClient.get(
				`/api/v2/billing/organizations/${encodeURIComponent(orgId)}/costs/instances`,
				{
					query: {
						from: params.from,
						to: params.to,
						include_names: params.include_names,
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
			title: "Elastic Cloud Billing: list instances with costs",
			description:
				"Elastic Cloud Billing Costs Analysis API (v2) -- list every instance (deployment, serverless project, integration) for the configured organisation across the requested time range, with cost totals per instance. Use this for the deployment_id -> instance_id mapping required by billing_get_instance_items / billing_get_instance_charts, or for a single-call deployment+cost inventory. org_id falls back to EC_DEFAULT_ORG_ID. from/to are required ISO 8601 timestamps. include_names=true joins through to the control plane to attach project names (slower). READ operation.",
			inputSchema: validator.shape,
		},
		handler,
	);
};

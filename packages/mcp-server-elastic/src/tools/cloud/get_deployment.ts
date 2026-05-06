// src/tools/cloud/get_deployment.ts

import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { CloudClient } from "../../clients/cloudClient.js";
import { logger } from "../../utils/logger.js";
import type { CloudToolRegistrationFunction, SearchResult, TextContent } from "../types.js";

const TOOL_NAME = "elasticsearch_cloud_get_deployment";

const validator = z.object({
	deployment_id: z.string().min(1),
	show_metadata: z.boolean().optional(),
	show_plans: z.boolean().optional(),
	show_plan_logs: z.boolean().optional(),
	show_settings: z.boolean().optional(),
	show_security: z.boolean().optional(),
});

type Params = z.infer<typeof validator>;

export const registerCloudGetDeploymentTool: CloudToolRegistrationFunction = (server, cloudClient: CloudClient) => {
	const handler = async (args: Params): Promise<SearchResult> => {
		const requestId = Math.random().toString(36).substring(7);
		try {
			const params = validator.parse(args);
			logger.info({ requestId, deploymentId: params.deployment_id }, `[${TOOL_NAME}] fetching deployment`);
			const result = await cloudClient.get(`/api/v1/deployments/${encodeURIComponent(params.deployment_id)}`, {
				query: {
					show_metadata: params.show_metadata,
					show_plans: params.show_plans,
					show_plan_logs: params.show_plan_logs,
					show_settings: params.show_settings,
					show_security: params.show_security,
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
			title: "Elastic Cloud: get deployment",
			description:
				"Elastic Cloud Deployment API -- fetch the full plan for one deployment, including per-tier autoscaling_max, autoscaling_min, size, zone_count, instance_configuration_id, and version. Use this to confirm autoscaling ceilings after a console plan change. READ operation. Operates on api.elastic-cloud.com, not on cluster state.",
			inputSchema: validator.shape,
		},
		handler,
	);
};

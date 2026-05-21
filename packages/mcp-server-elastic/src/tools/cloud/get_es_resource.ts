// src/tools/cloud/get_es_resource.ts

import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { CloudClient } from "../../clients/cloudClient.js";
import { logger } from "../../utils/logger.js";
import type { CloudToolRegistrationFunction, SearchResult, TextContent } from "../types.js";

const TOOL_NAME = "elasticsearch_cloud_get_es_resource";

const validator = z.object({
	deployment_id: z.string().min(1),
	ref_id: z.string().min(1).optional(),
	show_metadata: z.boolean().optional(),
	show_plans: z.boolean().optional(),
	show_plan_logs: z.boolean().optional(),
	show_plan_history: z.boolean().optional(),
	show_settings: z.boolean().optional(),
	show_system_alerts: z.number().int().optional(),
});

type Params = z.infer<typeof validator>;

export const registerCloudGetEsResourceTool: CloudToolRegistrationFunction = (server, cloudClient: CloudClient) => {
	const handler = async (args: Params): Promise<SearchResult> => {
		const requestId = Math.random().toString(36).substring(7);
		try {
			const params = validator.parse(args);
			const refId = params.ref_id ?? "main-elasticsearch";
			logger.info({ requestId, deploymentId: params.deployment_id, refId }, `[${TOOL_NAME}] fetching es resource`);
			const result = await cloudClient.get(
				`/api/v1/deployments/${encodeURIComponent(params.deployment_id)}/elasticsearch/${encodeURIComponent(refId)}`,
				{
					query: {
						show_metadata: params.show_metadata,
						show_plans: params.show_plans,
						show_plan_logs: params.show_plan_logs,
						show_plan_history: params.show_plan_history,
						show_settings: params.show_settings,
						show_system_alerts: params.show_system_alerts,
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
			title: "Elastic Cloud: get elasticsearch resource",
			description:
				'Elastic Cloud Deployment API -- fetch detailed info for a single elasticsearch resource inside a deployment, scoped tighter than cloud_get_deployment (avoids returning sibling Kibana/APM resources). Supports show_plan_history, show_plan_logs, and show_system_alerts. ref_id defaults to "main-elasticsearch". Use show_system_alerts to capture forced restarts due to memory limits. READ operation.',
			inputSchema: validator.shape,
		},
		handler,
	);
};

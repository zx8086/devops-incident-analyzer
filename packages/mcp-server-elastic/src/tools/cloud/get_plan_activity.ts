// src/tools/cloud/get_plan_activity.ts

import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { CloudClient } from "../../clients/cloudClient.js";
import { logger } from "../../utils/logger.js";
import type { CloudToolRegistrationFunction, SearchResult, TextContent } from "../types.js";

const TOOL_NAME = "elasticsearch_cloud_get_plan_activity";

const validator = z.object({
	deployment_id: z.string().min(1),
	ref_id: z.string().min(1).optional(),
});

type Params = z.infer<typeof validator>;

export const registerCloudGetPlanActivityTool: CloudToolRegistrationFunction = (server, cloudClient: CloudClient) => {
	const handler = async (args: Params): Promise<SearchResult> => {
		const requestId = Math.random().toString(36).substring(7);
		try {
			const params = validator.parse(args);
			// Single-cluster deployments use ref_id "main-elasticsearch". Multi-cluster setups
			// must pass an explicit ref_id (the get_deployment payload lists the available refs).
			const refId = params.ref_id ?? "main-elasticsearch";
			logger.info({ requestId, deploymentId: params.deployment_id, refId }, `[${TOOL_NAME}] fetching plan activity`);
			const result = await cloudClient.get(
				`/api/v1/deployments/${encodeURIComponent(params.deployment_id)}/elasticsearch/${encodeURIComponent(refId)}/plan/activity`,
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
			title: "Elastic Cloud: get plan activity",
			description:
				'Elastic Cloud Deployment API -- watch a running plan change for one deployment\'s elasticsearch resource. Returns current step, rolling-restart progress, and exit codes (e.g. 74 = warm-disk-blocks-plan). Use during cold/warm/hot tier resize, AZ change, or version upgrade. ref_id defaults to "main-elasticsearch" (override for multi-cluster deployments). READ operation.',
			inputSchema: validator.shape,
		},
		handler,
	);
};

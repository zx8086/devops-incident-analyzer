// src/tools/cloud/get_plan_history.ts

import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { CloudClient } from "../../clients/cloudClient.js";
import { logger } from "../../utils/logger.js";
import type { CloudToolRegistrationFunction, SearchResult, TextContent } from "../types.js";

const TOOL_NAME = "elasticsearch_cloud_get_plan_history";

const validator = z.object({
	deployment_id: z.string().min(1),
	ref_id: z.string().min(1).optional(),
});

type Params = z.infer<typeof validator>;

export const registerCloudGetPlanHistoryTool: CloudToolRegistrationFunction = (server, cloudClient: CloudClient) => {
	const handler = async (args: Params): Promise<SearchResult> => {
		const requestId = Math.random().toString(36).substring(7);
		try {
			const params = validator.parse(args);
			const refId = params.ref_id ?? "main-elasticsearch";
			logger.info({ requestId, deploymentId: params.deployment_id, refId }, `[${TOOL_NAME}] fetching plan history`);
			const result = await cloudClient.get(
				`/api/v1/deployments/${encodeURIComponent(params.deployment_id)}/elasticsearch/${encodeURIComponent(refId)}/plan/history`,
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
			title: "Elastic Cloud: get plan history",
			description:
				'Elastic Cloud Deployment API -- list prior plans for one deployment\'s elasticsearch resource (e.g. plan IDs #187..#194). Useful for investigating when an autoscaling ceiling was last changed or which plan introduced a regression. ref_id defaults to "main-elasticsearch". READ operation.',
			inputSchema: validator.shape,
		},
		handler,
	);
};

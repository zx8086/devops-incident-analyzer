// src/tools/cloud/list_deployments.ts

import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { CloudClient } from "../../clients/cloudClient.js";
import { logger } from "../../utils/logger.js";
import type { CloudToolRegistrationFunction, SearchResult, TextContent } from "../types.js";

const TOOL_NAME = "elasticsearch_cloud_list_deployments";

const validator = z.object({
	// Cloud API doesn't accept filters on this endpoint -- args are intentionally empty so the
	// tool description carries the contract instead of the schema.
});

type Params = z.infer<typeof validator>;

export const registerCloudListDeploymentsTool: CloudToolRegistrationFunction = (server, cloudClient: CloudClient) => {
	const handler = async (args: Params): Promise<SearchResult> => {
		const requestId = Math.random().toString(36).substring(7);
		try {
			validator.parse(args);
			logger.info({ requestId }, `[${TOOL_NAME}] listing deployments`);
			const result = await cloudClient.get("/api/v1/deployments");
			return {
				content: [{ type: "text", text: JSON.stringify(result, null, 2) } as TextContent],
			};
		} catch (error) {
			if (error instanceof McpError) throw error;
			if (error instanceof z.ZodError) {
				throw new McpError(ErrorCode.InvalidParams, `[${TOOL_NAME}] Validation failed`, {
					issues: error.issues,
				});
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
			title: "Elastic Cloud: list deployments",
			description:
				"Elastic Cloud Deployment API -- list all deployments visible to the configured EC_API_KEY. Returns deployment IDs, names, regions, and high-level resource refs. READ operation. Use cloud_get_deployment for the full plan including autoscaling_max/min per tier. Operates on api.elastic-cloud.com, not on cluster state.",
			inputSchema: validator.shape,
		},
		handler,
	);
};

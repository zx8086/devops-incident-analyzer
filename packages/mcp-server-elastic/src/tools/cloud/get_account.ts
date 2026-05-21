// src/tools/cloud/get_account.ts

import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { CloudClient } from "../../clients/cloudClient.js";
import { logger } from "../../utils/logger.js";
import type { CloudToolRegistrationFunction, SearchResult, TextContent } from "../types.js";

const TOOL_NAME = "elasticsearch_cloud_get_account";

const validator = z.object({});

type Params = z.infer<typeof validator>;

export const registerCloudGetAccountTool: CloudToolRegistrationFunction = (server, cloudClient: CloudClient) => {
	const handler = async (args: Params): Promise<SearchResult> => {
		const requestId = Math.random().toString(36).substring(7);
		try {
			validator.parse(args);
			logger.info({ requestId }, `[${TOOL_NAME}] fetching current account`);
			const result = await cloudClient.get("/api/v1/account");
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
			title: "Elastic Cloud: get current account",
			description:
				"Elastic Cloud Account API -- fetch the account profile for the configured EC_API_KEY. The response includes the organization_id, which all Billing API endpoints require. Use this when EC_DEFAULT_ORG_ID is not set or to verify which org the key belongs to before issuing billing queries. READ operation. Operates on api.elastic-cloud.com.",
			inputSchema: validator.shape,
		},
		handler,
	);
};

// src/tools/cloud/cancel_pending_plan.ts

import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { CloudClient } from "../../clients/cloudClient.js";
import { logger } from "../../utils/logger.js";
import { readOnlyManager } from "../../utils/readOnlyMode.js";
import type { CloudToolRegistrationFunction, SearchResult, TextContent } from "../types.js";

const TOOL_NAME = "elasticsearch_cloud_cancel_pending_plan";

const validator = z.object({
	deployment_id: z.string().min(1),
	resource_kind: z
		.enum(["elasticsearch", "kibana", "apm", "appsearch", "enterprise_search", "integrations_server"])
		.optional(),
	ref_id: z.string().min(1).optional(),
	force_delete: z.boolean().optional(),
	ignore_missing: z.boolean().optional(),
});

type Params = z.infer<typeof validator>;

export const registerCloudCancelPendingPlanTool: CloudToolRegistrationFunction = (server, cloudClient: CloudClient) => {
	const handler = async (args: Params): Promise<SearchResult> => {
		const requestId = Math.random().toString(36).substring(7);
		try {
			const params = validator.parse(args);

			const readOnlyCheck = readOnlyManager?.checkOperation(TOOL_NAME);
			if (readOnlyCheck && !readOnlyCheck.allowed) {
				return readOnlyManager.createBlockedResponse(TOOL_NAME);
			}

			const resourceKind = params.resource_kind ?? "elasticsearch";
			const refId = params.ref_id ?? "main-elasticsearch";
			logger.info(
				{ requestId, deploymentId: params.deployment_id, resourceKind, refId, forceDelete: params.force_delete },
				`[${TOOL_NAME}] cancelling pending plan`,
			);
			const result = await cloudClient.del(
				`/api/v1/deployments/${encodeURIComponent(params.deployment_id)}/${encodeURIComponent(resourceKind)}/${encodeURIComponent(refId)}/plan/pending`,
				{
					query: {
						force_delete: params.force_delete,
						ignore_missing: params.ignore_missing,
					},
				},
			);
			const response: SearchResult = {
				content: [{ type: "text", text: JSON.stringify(result, null, 2) } as TextContent],
			};
			if (readOnlyCheck?.warning) {
				return readOnlyManager.createWarningResponse(TOOL_NAME, response);
			}
			return response;
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
			title: "Elastic Cloud: cancel pending plan",
			description:
				'Elastic Cloud Deployment API -- cancel the in-flight plan change for one resource of a deployment (default resource_kind=elasticsearch, ref_id=main-elasticsearch). Use to abort a bad plan change without the Cloud Console -- e.g. revert a stuck warm-disk-blocks-plan (exit code 74) or an autoscaling resize that is hitting capacity issues. force_delete=true skips graceful cancellation. ignore_missing=true treats "no pending plan" as success. WRITE/DESTRUCTIVE operation: blocked when READ_ONLY_MODE=true. Operates on api.elastic-cloud.com.',
			inputSchema: validator.shape,
		},
		handler,
	);
};

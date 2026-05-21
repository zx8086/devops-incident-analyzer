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
	force_all_plan_history: z.boolean().optional(),
});

type Params = z.infer<typeof validator>;

// Subset of the Get Deployment response we depend on. The Cloud API returns much more;
// we only need plan_info.history per elasticsearch resource ref.
interface DeploymentResponse {
	resources?: {
		elasticsearch?: Array<{
			ref_id?: string;
			info?: {
				plan_info?: {
					history?: unknown[];
				};
			};
		}>;
	};
}

export const registerCloudGetPlanHistoryTool: CloudToolRegistrationFunction = (server, cloudClient: CloudClient) => {
	const handler = async (args: Params): Promise<SearchResult> => {
		const requestId = Math.random().toString(36).substring(7);
		try {
			const params = validator.parse(args);
			const refId = params.ref_id ?? "main-elasticsearch";
			logger.info({ requestId, deploymentId: params.deployment_id, refId }, `[${TOOL_NAME}] fetching plan history`);
			// The ECE-only /plan/history endpoint 404s on Elastic Cloud Hosted. The supported
			// ECH surface is the embedded plan_info.history populated by show_plan_history=true.
			const deployment = await cloudClient.get<DeploymentResponse>(
				`/api/v1/deployments/${encodeURIComponent(params.deployment_id)}`,
				{
					query: {
						show_plans: true,
						show_plan_history: true,
						show_plan_logs: true,
						force_all_plan_history: params.force_all_plan_history,
					},
				},
			);
			const esResources = deployment?.resources?.elasticsearch ?? [];
			const target = esResources.find((r) => r.ref_id === refId) ?? esResources[0];
			const history = target?.info?.plan_info?.history ?? [];
			return {
				content: [
					{
						type: "text",
						text: JSON.stringify(
							{ deployment_id: params.deployment_id, ref_id: target?.ref_id ?? refId, history },
							null,
							2,
						),
					} as TextContent,
				],
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
				'Elastic Cloud Deployment API -- list prior plans for one deployment\'s elasticsearch resource. On Elastic Cloud Hosted (ECH) this reads the embedded plan_info.history from GET /deployments/{id}?show_plan_history=true (the standalone /plan/history endpoint is ECE-only and 404s on ECH). Useful for investigating when an autoscaling ceiling was last changed or which plan introduced a regression. ref_id defaults to "main-elasticsearch". Pass force_all_plan_history=true to bypass the default first-10 + last-90 cap. READ operation.',
			inputSchema: validator.shape,
		},
		handler,
	);
};

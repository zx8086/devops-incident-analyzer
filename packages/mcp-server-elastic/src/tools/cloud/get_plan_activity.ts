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

interface DeploymentResponse {
	resources?: {
		elasticsearch?: Array<{
			ref_id?: string;
			info?: {
				plan_info?: {
					pending?: unknown;
				};
			};
		}>;
	};
}

export const registerCloudGetPlanActivityTool: CloudToolRegistrationFunction = (server, cloudClient: CloudClient) => {
	const handler = async (args: Params): Promise<SearchResult> => {
		const requestId = Math.random().toString(36).substring(7);
		try {
			const params = validator.parse(args);
			// Single-cluster deployments use ref_id "main-elasticsearch". Multi-cluster setups
			// must pass an explicit ref_id (the get_deployment payload lists the available refs).
			const refId = params.ref_id ?? "main-elasticsearch";
			logger.info({ requestId, deploymentId: params.deployment_id, refId }, `[${TOOL_NAME}] fetching plan activity`);
			// The ECE-only /plan/activity endpoint 404s on Elastic Cloud Hosted. The supported
			// ECH surface is the embedded plan_info.pending populated by show_plans=true.
			// notFoundOk lets us return a structured payload when the deployment itself is gone.
			const deployment = await cloudClient.get<DeploymentResponse>(
				`/api/v1/deployments/${encodeURIComponent(params.deployment_id)}`,
				{
					query: { show_plans: true, show_plan_logs: true },
					notFoundOk: true,
				},
			);
			if (deployment === null) {
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify(
								{ status: "deployment_not_found", deployment_id: params.deployment_id, ref_id: refId },
								null,
								2,
							),
						} as TextContent,
					],
				};
			}
			const esResources = deployment.resources?.elasticsearch ?? [];
			const target = esResources.find((r) => r.ref_id === refId) ?? esResources[0];
			const pending = target?.info?.plan_info?.pending;
			if (!pending) {
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify(
								{
									status: "no_plan_in_progress",
									deployment_id: params.deployment_id,
									ref_id: target?.ref_id ?? refId,
								},
								null,
								2,
							),
						} as TextContent,
					],
				};
			}
			return {
				content: [
					{
						type: "text",
						text: JSON.stringify(
							{
								status: "plan_in_progress",
								deployment_id: params.deployment_id,
								ref_id: target?.ref_id ?? refId,
								pending,
							},
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
			title: "Elastic Cloud: get plan activity",
			description:
				'Elastic Cloud Deployment API -- inspect the currently-running plan change for one deployment\'s elasticsearch resource. On Elastic Cloud Hosted (ECH) this reads the embedded plan_info.pending from GET /deployments/{id}?show_plans=true&show_plan_logs=true (the standalone /plan/activity endpoint is ECE-only and 404s on ECH). Returns {status:"plan_in_progress", pending} while a plan is running (with current step, rolling-restart progress, exit codes such as 74 = warm-disk-blocks-plan), or {status:"no_plan_in_progress"} when idle. ECH does not retain post-completion activity -- use elasticsearch_cloud_get_plan_history after the fact. ref_id defaults to "main-elasticsearch". READ operation.',
			inputSchema: validator.shape,
		},
		handler,
	);
};

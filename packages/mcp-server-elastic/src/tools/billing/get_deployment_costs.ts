// src/tools/billing/get_deployment_costs.ts

import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { CloudClient } from "../../clients/cloudClient.js";
import { logger } from "../../utils/logger.js";
import type { CloudToolRegistrationFunction, SearchResult, TextContent } from "../types.js";

const TOOL_NAME = "elasticsearch_billing_get_deployment_costs";

// SIO-678: There is no dedicated v2 per-deployment items endpoint. The /costs/items
// payload omits deployment attribution on line items. The only API that breaks costs
// down per deployment is /charts, which returns data[].values[] entries with
// {id, name, type:"deployment", value}. We hit that and filter to the requested deployment.
const validatorShape = {
	deployment_id: z.string().min(1).optional(),
	deployment_name: z.string().min(1).optional(),
	org_id: z.string().min(1).optional(),
	from: z.string().min(1),
	to: z.string().min(1),
	bucketing_strategy: z.enum(["daily", "monthly"]).optional(),
};
const validator = z.object(validatorShape).refine((d) => Boolean(d.deployment_id) || Boolean(d.deployment_name), {
	message: "either deployment_id or deployment_name is required",
	path: ["deployment_id"],
});

type Params = z.infer<typeof validator>;

interface ChartValue {
	id: string;
	name: string;
	type: string;
	value: number;
}
interface ChartBucket {
	timestamp: number;
	values: ChartValue[];
}
interface ChartsResponse {
	data: ChartBucket[];
}

export const registerBillingGetDeploymentCostsTool: CloudToolRegistrationFunction = (
	server,
	cloudClient: CloudClient,
) => {
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
			const bucketingStrategy = params.bucketing_strategy ?? "monthly";
			logger.info(
				{
					requestId,
					orgId,
					deploymentId: params.deployment_id,
					deploymentName: params.deployment_name,
					from: params.from,
					to: params.to,
					bucketingStrategy,
				},
				`[${TOOL_NAME}] fetching deployment costs via charts endpoint`,
			);
			const charts = await cloudClient.get<ChartsResponse>(
				`/api/v2/billing/organizations/${encodeURIComponent(orgId)}/charts`,
				{
					query: {
						from: params.from,
						to: params.to,
						bucketing_strategy: bucketingStrategy,
					},
				},
			);

			const matches = (v: ChartValue) =>
				v.type === "deployment" &&
				((params.deployment_id && v.id === params.deployment_id) ||
					(params.deployment_name && v.name === params.deployment_name));

			const filteredBuckets: ChartBucket[] = [];
			let totalEcu = 0;
			let resolvedId: string | undefined;
			let resolvedName: string | undefined;
			for (const bucket of charts.data ?? []) {
				const filtered = (bucket.values ?? []).filter(matches);
				if (filtered.length === 0) continue;
				if (!resolvedId) resolvedId = filtered[0]?.id;
				if (!resolvedName) resolvedName = filtered[0]?.name;
				for (const v of filtered) totalEcu += v.value;
				filteredBuckets.push({ timestamp: bucket.timestamp, values: filtered });
			}

			if (filteredBuckets.length === 0) {
				throw new McpError(
					ErrorCode.InvalidParams,
					`[${TOOL_NAME}] no chart data found for deployment ${params.deployment_id ?? params.deployment_name} in the requested range`,
				);
			}

			const result = {
				deployment_id: resolvedId,
				deployment_name: resolvedName,
				bucketing_strategy: bucketingStrategy,
				from: params.from,
				to: params.to,
				total_ecu: totalEcu,
				data: filteredBuckets,
			};
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
			title: "Elastic Cloud Billing: per-deployment cost time-series",
			description:
				"Elastic Cloud Billing Charts API (v2), filtered to a single deployment. The v2 API has no dedicated per-deployment items endpoint, so this is derived by calling /charts and filtering data[].values[] where type='deployment' and id (or name) matches. Returns the matching buckets plus a summed total_ecu. Either deployment_id or deployment_name must be provided. org_id falls back to EC_DEFAULT_ORG_ID. from/to are required ISO 8601; bucketing_strategy defaults to 'monthly'. READ operation.",
			inputSchema: validatorShape,
		},
		handler,
	);
};

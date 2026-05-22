// src/tools/cloud/get_hardware_profile.ts

import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { CloudClient } from "../../clients/cloudClient.js";
import { logger } from "../../utils/logger.js";
import type { CloudToolRegistrationFunction, SearchResult, TextContent } from "../types.js";

const TOOL_NAME = "elasticsearch_cloud_get_hardware_profile";

const validator = z.object({
	template_id: z
		.string()
		.min(1)
		.describe(
			"Deployment template ID, e.g. 'aws-cpu-optimized'. Obtain from elasticsearch_cloud_list_hardware_profiles.",
		),
	region: z.string().min(1).describe("Elastic Cloud region string, e.g. 'aws-eu-central-1'."),
});

type Params = z.infer<typeof validator>;

interface AllowedSize {
	value?: number;
	resource?: string;
}

interface TopologyElement {
	id?: string;
	instance_configuration_id?: string;
	size?: AllowedSize;
	zone_count?: number;
	// Elastic returns allowed_sizes[] for supported discrete step values
	allowed_sizes?: AllowedSize[];
}

interface DeploymentTemplate {
	id: string;
	name?: string;
	description?: string;
	deployment_template?: {
		resources?: {
			elasticsearch?: Array<{
				plan?: {
					cluster_topology?: TopologyElement[];
				};
			}>;
		};
	};
}

function mbToGb(value?: number, resource?: string): number | null {
	if (!value || resource?.toLowerCase() !== "memory") return null;
	return value / 1024;
}

function allowedGbSizes(sizes?: AllowedSize[]): number[] {
	if (!sizes) return [];
	return sizes.filter((s) => s.resource?.toLowerCase() === "memory" && s.value).map((s) => (s.value as number) / 1024);
}

export const registerCloudGetHardwareProfileTool: CloudToolRegistrationFunction = (
	server,
	cloudClient: CloudClient,
) => {
	const handler = async (args: Params): Promise<SearchResult> => {
		const requestId = Math.random().toString(36).substring(7);
		try {
			const params = validator.parse(args);
			logger.info(
				{ requestId, templateId: params.template_id, region: params.region },
				`[${TOOL_NAME}] fetching hardware profile`,
			);

			const tpl = await cloudClient.get<DeploymentTemplate>(
				`/api/v1/deployments/templates/${encodeURIComponent(params.template_id)}`,
				{ query: { region: params.region } },
			);

			const esTopology = tpl.deployment_template?.resources?.elasticsearch?.[0]?.plan?.cluster_topology ?? [];

			const topology = esTopology.map((t) => ({
				topology_id: t.id ?? null,
				instance_configuration_id: t.instance_configuration_id ?? null,
				default_size_gb_ram: mbToGb(t.size?.value, t.size?.resource),
				zone_count: t.zone_count ?? null,
				allowed_sizes_gb_ram: allowedGbSizes(t.allowed_sizes),
			}));

			const result = {
				template_id: tpl.id,
				name: tpl.name ?? null,
				description: tpl.description ?? null,
				region: params.region,
				elasticsearch_topology: topology,
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
			title: "Elastic Cloud: get hardware profile detail",
			description:
				"Elastic Cloud Deployment Templates API -- fetch the full detail for a single hardware profile (deployment template). Returns each Elasticsearch topology tier's instance_configuration_id, default size (GB RAM), zone count, and allowed_sizes_gb_ram[] (the discrete steps you can choose when creating or migrating a deployment). Use elasticsearch_cloud_list_hardware_profiles to discover template_id values. READ operation.",
			inputSchema: validator.shape,
		},
		handler,
	);
};

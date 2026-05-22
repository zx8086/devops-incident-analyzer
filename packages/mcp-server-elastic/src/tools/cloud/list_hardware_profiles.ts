// src/tools/cloud/list_hardware_profiles.ts

import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { CloudClient } from "../../clients/cloudClient.js";
import { logger } from "../../utils/logger.js";
import type { CloudToolRegistrationFunction, SearchResult, TextContent } from "../types.js";

const TOOL_NAME = "elasticsearch_cloud_list_hardware_profiles";

const validator = z.object({
	region: z
		.string()
		.min(1)
		.describe(
			"Elastic Cloud region string, e.g. 'aws-eu-central-1'. Use the internal Elastic format (provider prefix + AWS/GCP/Azure region), not the bare cloud provider region.",
		),
	hide_deprecated: z.boolean().optional().describe("Omit deprecated templates from the response. Defaults to true."),
});

type Params = z.infer<typeof validator>;

interface TopologySize {
	value?: number;
	resource?: string;
}

interface TopologyElement {
	id?: string;
	instance_configuration_id?: string;
	size?: TopologySize;
	zone_count?: number;
}

interface EsResource {
	plan?: {
		cluster_topology?: TopologyElement[];
	};
}

interface DeploymentTemplate {
	id: string;
	name?: string;
	description?: string;
	deployment_template?: {
		resources?: {
			elasticsearch?: EsResource[];
		};
	};
}

type TemplatesResponse = DeploymentTemplate[] | { deployment_templates?: DeploymentTemplate[] };

function toGbRam(value?: number, resource?: string): number | null {
	if (!value || resource?.toLowerCase() !== "memory") return null;
	return value / 1024;
}

export const registerCloudListHardwareProfilesTool: CloudToolRegistrationFunction = (
	server,
	cloudClient: CloudClient,
) => {
	const handler = async (args: Params): Promise<SearchResult> => {
		const requestId = Math.random().toString(36).substring(7);
		try {
			const params = validator.parse(args);
			const hideDeprecated = params.hide_deprecated ?? true;
			logger.info({ requestId, region: params.region, hideDeprecated }, `[${TOOL_NAME}] listing hardware profiles`);

			const raw = await cloudClient.get<TemplatesResponse>("/api/v1/deployments/templates", {
				query: { region: params.region, hide_deprecated: hideDeprecated },
			});

			const templates: DeploymentTemplate[] = Array.isArray(raw)
				? raw
				: ((raw as { deployment_templates?: DeploymentTemplate[] }).deployment_templates ?? []);

			const profiles = templates.map((tpl) => {
				const esTopology = tpl.deployment_template?.resources?.elasticsearch?.[0]?.plan?.cluster_topology ?? [];

				const topology = esTopology.map((t) => ({
					topology_id: t.id ?? null,
					instance_configuration_id: t.instance_configuration_id ?? null,
					default_size_gb_ram: toGbRam(t.size?.value, t.size?.resource),
					zone_count: t.zone_count ?? null,
				}));

				return {
					template_id: tpl.id,
					name: tpl.name ?? null,
					description: tpl.description ?? null,
					elasticsearch_topology: topology,
				};
			});

			const result = {
				region: params.region,
				profile_count: profiles.length,
				profiles,
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
			title: "Elastic Cloud: list hardware profiles",
			description:
				"Elastic Cloud Deployment Templates API -- list all available hardware profiles (deployment templates) for a given region. Each profile entry includes the template_id (e.g. 'aws-cpu-optimized'), display name, and the Elasticsearch cluster_topology[] with per-tier instance_configuration_id, default RAM (GB), and zone count. region must use the Elastic internal format, e.g. 'aws-eu-central-1' not 'eu-central-1'. Use elasticsearch_cloud_get_hardware_profile to fetch full size options for a single profile. READ operation.",
			inputSchema: validator.shape,
		},
		handler,
	);
};

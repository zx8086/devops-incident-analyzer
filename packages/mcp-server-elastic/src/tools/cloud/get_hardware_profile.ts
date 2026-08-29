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

// SIO-1570: the discrete size ladder lives here, NOT on cluster_topology[]. The template's
// topology only carries the tier's default size (and that is 0 on every tier but hot_content),
// so joining on instance_configuration_id is the only way to get the selectable sizes.
interface InstanceConfiguration {
	id?: string;
	name?: string;
	discrete_sizes?: {
		sizes?: number[];
		default_size?: number;
		resource?: string;
	};
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
	instance_configurations?: InstanceConfiguration[];
}

function mibToGb(value?: number | null): number | null {
	if (value === undefined || value === null || value <= 0) return null;
	return value / 1024;
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
				{ query: { region: params.region, show_instance_configurations: true } },
			);

			const esTopology = tpl.deployment_template?.resources?.elasticsearch?.[0]?.plan?.cluster_topology ?? [];

			// Index the sibling instance_configurations[] by id so each tier can resolve its ladder.
			const icById = new Map<string, InstanceConfiguration>();
			for (const ic of tpl.instance_configurations ?? []) {
				if (ic.id) icById.set(ic.id, ic);
			}

			const unresolvedIcs: string[] = [];

			const topology = esTopology.map((t) => {
				const icId = t.instance_configuration_id ?? null;
				const ic = icId ? icById.get(icId) : undefined;
				if (icId && !ic) unresolvedIcs.push(icId);

				const discrete = ic?.discrete_sizes;
				// Sizes are MiB of RAM. Kept as the primary field because the ladder is not
				// whole-GB throughout (e.g. 29696 MiB = 29 GB), so GB alone is lossy downstream.
				const sizesMib = (discrete?.sizes ?? []).filter((n) => typeof n === "number" && n > 0);
				// The topology default is 0 on every tier but hot_content; fall back to the IC's own default.
				const defaultMib =
					t.size?.resource?.toLowerCase() === "memory" && t.size?.value
						? t.size.value
						: (discrete?.default_size ?? null);

				return {
					topology_id: t.id ?? null,
					instance_configuration_id: icId,
					zone_count: t.zone_count ?? null,
					default_size_mb_ram: defaultMib && defaultMib > 0 ? defaultMib : null,
					default_size_gb_ram: mibToGb(defaultMib),
					allowed_sizes_mb_ram: sizesMib,
					allowed_sizes_gb_ram: sizesMib.map((n) => n / 1024),
				};
			});

			const result = {
				template_id: tpl.id,
				name: tpl.name ?? null,
				description: tpl.description ?? null,
				region: params.region,
				elasticsearch_topology: topology,
				// Non-empty only when a tier's instance_configuration_id had no matching entry in
				// instance_configurations[]; distinguishes "no ladder exists" from "join failed".
				unresolved_instance_configurations: unresolvedIcs,
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
				"Elastic Cloud Deployment Templates API -- fetch the full detail for a single hardware profile (deployment template). Returns each Elasticsearch topology tier's instance_configuration_id, zone count, default size, and the discrete size ladder you can choose when creating or migrating a deployment. Sizes are given in BOTH allowed_sizes_mb_ram[] (MiB, authoritative -- the ladder is not whole-GB throughout, e.g. 29696 MiB) and allowed_sizes_gb_ram[] (convenience). The ladder is resolved by joining each tier's instance_configuration_id against the template's instance_configurations[]; any tier whose IC could not be resolved is listed in unresolved_instance_configurations[]. Use elasticsearch_cloud_list_hardware_profiles to discover template_id values (pass hide_deprecated=false to reach pinned/older instance configurations). READ operation.",
			inputSchema: validator.shape,
		},
		handler,
	);
};

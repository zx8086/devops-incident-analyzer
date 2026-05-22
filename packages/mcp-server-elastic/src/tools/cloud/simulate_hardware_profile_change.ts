// src/tools/cloud/simulate_hardware_profile_change.ts

import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { CloudClient } from "../../clients/cloudClient.js";
import { logger } from "../../utils/logger.js";
import type { CloudToolRegistrationFunction, SearchResult, TextContent } from "../types.js";

const TOOL_NAME = "elasticsearch_cloud_simulate_hardware_profile_change";

// 730 hours/month (365 * 24 / 12)
const HOURS_PER_MONTH = 730;

const validator = z.object({
	deployment_id: z.string().min(1).describe("ID of the deployment to simulate the profile change for."),
	target_template_id: z
		.string()
		.min(1)
		.describe(
			"Deployment template ID to switch to, e.g. 'aws-cpu-optimized'. Obtain from elasticsearch_cloud_list_hardware_profiles.",
		),
	region: z
		.string()
		.min(1)
		.describe("Elastic Cloud region string, e.g. 'aws-eu-central-1'. Must match the deployment's region."),
	org_id: z
		.string()
		.min(1)
		.optional()
		.describe(
			"Elastic Cloud organisation ID. Falls back to EC_DEFAULT_ORG_ID. Required to look up actual billing rates from this deployment's invoice history.",
		),
});

type Params = z.infer<typeof validator>;

// ----- Elastic Cloud API shapes (subset) -----

interface TopologySize {
	value?: number;
	resource?: string;
}

interface TopologyElement {
	id?: string;
	instance_configuration_id?: string;
	size?: TopologySize;
	zone_count?: number;
	allowed_sizes?: TopologySize[];
}

interface DeploymentTemplate {
	id: string;
	name?: string;
	deployment_template?: {
		resources?: {
			elasticsearch?: Array<{
				plan?: { cluster_topology?: TopologyElement[] };
			}>;
		};
	};
}

interface EsPlan {
	cluster_topology?: TopologyElement[];
	deployment_template?: { id?: string };
}

interface EsResourcePlanInfo {
	current?: { plan?: EsPlan };
}

interface EsResource {
	region?: string;
	info?: { plan_info?: EsResourcePlanInfo };
}

interface Deployment {
	id?: string;
	name?: string;
	resources?: { elasticsearch?: EsResource[] };
}

// Billing API: /costs/instances/<id>/items response shape
interface ProductLineItem {
	name?: string;
	sku?: string;
	kind?: string;
	quantity?: number;
	// rate is ECU per unit (GB-RAM-hour for compute line items)
	rate?: number;
	total_ecu?: number;
}

interface BillingProduct {
	name?: string;
	product_line_items?: ProductLineItem[];
}

interface InstanceItemsResponse {
	total_ecu?: number;
	products?: BillingProduct[];
}

// ----- Rate extraction from billing data -----

// Elastic billing line items for Elasticsearch hot-tier compute use SKUs / names that contain
// keywords identifying them as RAM-based compute. We pick the first matching line item's rate.
// Known patterns from the v2 billing API:
//   name: "Elasticsearch", kind: "elasticsearch", sku contains "memory" or "ram"
//   name may be "Elasticsearch - Hot", "Elasticsearch compute" etc.
const ES_COMPUTE_KEYWORDS = ["elasticsearch", "hot", "compute", "memory", "ram"];

function isEsComputeLineItem(item: ProductLineItem): boolean {
	const haystack = `${item.name ?? ""} ${item.sku ?? ""} ${item.kind ?? ""}`.toLowerCase();
	return ES_COMPUTE_KEYWORDS.filter((k) => haystack.includes(k)).length >= 2;
}

function extractRateFromBilling(response: InstanceItemsResponse): number | null {
	for (const product of response.products ?? []) {
		for (const item of product.product_line_items ?? []) {
			if (item.rate && item.rate > 0 && isEsComputeLineItem(item)) {
				return item.rate;
			}
		}
	}
	return null;
}

// Fetch the actual billed rate for this deployment from the last 30 days of billing.
// Returns { rate, source } where source describes how the rate was obtained.
async function resolveRatePerGbRamHour(
	cloudClient: CloudClient,
	deploymentId: string,
	orgId: string,
): Promise<{ rate: number; source: string } | null> {
	try {
		// Use the last 30 days as the billing window — enough history for stable rate data
		const to = new Date();
		const from = new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000);
		const fromStr = from.toISOString().slice(0, 10);
		const toStr = to.toISOString().slice(0, 10);

		const items = await cloudClient.get<InstanceItemsResponse>(
			`/api/v2/billing/organizations/${encodeURIComponent(orgId)}/costs/instances/${encodeURIComponent(deploymentId)}/items`,
			{ query: { from: fromStr, to: toStr }, notFoundOk: true },
		);

		if (!items) return null;

		const rate = extractRateFromBilling(items);
		if (rate === null) return null;

		return {
			rate,
			source: `billing API (last 30 days): actual ECU/GB-RAM-hour charged for this deployment`,
		};
	} catch {
		// Billing fetch is best-effort — don't propagate to the caller
		return null;
	}
}

// ----- Topology helpers -----

function mbToGb(value?: number, resource?: string): number {
	if (!value || resource?.toLowerCase() !== "memory") return 0;
	return value / 1024;
}

function summariseTopology(topology: TopologyElement[]): {
	topology_id: string | null;
	instance_configuration_id: string | null;
	size_gb_ram: number;
	zone_count: number;
	monthly_gb_ram_zones: number;
}[] {
	return topology.map((t) => {
		const gb = mbToGb(t.size?.value, t.size?.resource);
		const zones = t.zone_count ?? 1;
		return {
			topology_id: t.id ?? null,
			instance_configuration_id: t.instance_configuration_id ?? null,
			size_gb_ram: gb,
			zone_count: zones,
			monthly_gb_ram_zones: gb * zones,
		};
	});
}

function totalGbRamZones(topology: TopologyElement[]): number {
	return topology.reduce((sum, t) => {
		const gb = mbToGb(t.size?.value, t.size?.resource);
		return sum + gb * (t.zone_count ?? 1);
	}, 0);
}

// ----- Cost estimate builder -----

function buildCostEstimate(
	currentGbRamZones: number,
	targetGbRamZones: number,
	resolvedRate: { rate: number; source: string } | null,
	configRate: number | undefined,
): {
	rate_per_gb_ram_hour: number | null;
	rate_source: string;
	current_monthly_ecu: number | null;
	target_monthly_ecu: number | null;
	delta_monthly_ecu: number | null;
	note: string;
} {
	const effective =
		resolvedRate ?? (configRate ? { rate: configRate, source: "EC_PRICE_PER_GB_RAM_HOUR env var" } : null);

	if (!effective) {
		return {
			rate_per_gb_ram_hour: null,
			rate_source: "unavailable",
			current_monthly_ecu: null,
			target_monthly_ecu: null,
			delta_monthly_ecu: null,
			note: "Could not determine rate. Set EC_PRICE_PER_GB_RAM_HOUR as a fallback, or ensure the deployment has billing history in the last 30 days and org_id is provided. Consult the Elastic Cloud pricing page for your region and subscription tier.",
		};
	}

	const currentMonthly = currentGbRamZones * effective.rate * HOURS_PER_MONTH;
	const targetMonthly = targetGbRamZones * effective.rate * HOURS_PER_MONTH;

	return {
		rate_per_gb_ram_hour: effective.rate,
		rate_source: effective.source,
		current_monthly_ecu: Math.round(currentMonthly * 100) / 100,
		target_monthly_ecu: Math.round(targetMonthly * 100) / 100,
		delta_monthly_ecu: Math.round((targetMonthly - currentMonthly) * 100) / 100,
		note: "Estimate covers Elasticsearch RAM × zones × rate. Actual billing also includes snapshot storage, data transfer, and non-compute tiers. Verify realised spend with elasticsearch_billing_get_deployment_costs after any plan change.",
	};
}

export const registerCloudSimulateHardwareProfileChangeTool: CloudToolRegistrationFunction = (
	server,
	cloudClient: CloudClient,
) => {
	const handler = async (args: Params): Promise<SearchResult> => {
		const requestId = Math.random().toString(36).substring(7);
		try {
			const params = validator.parse(args);
			const orgId = params.org_id ?? cloudClient.defaultOrgId;
			logger.info(
				{
					requestId,
					deploymentId: params.deployment_id,
					targetTemplateId: params.target_template_id,
					region: params.region,
					orgId: orgId ?? null,
				},
				`[${TOOL_NAME}] simulating hardware profile change`,
			);

			// Fetch deployment and target template in parallel
			const [deployment, targetTemplate] = await Promise.all([
				cloudClient.get<Deployment>(`/api/v1/deployments/${encodeURIComponent(params.deployment_id)}`, {
					query: { show_plans: true },
				}),
				cloudClient.get<DeploymentTemplate>(
					`/api/v1/deployments/templates/${encodeURIComponent(params.target_template_id)}`,
					{ query: { region: params.region } },
				),
			]);

			// Extract current deployment topology
			const esResource = deployment.resources?.elasticsearch?.[0];
			const currentPlan = esResource?.info?.plan_info?.current?.plan;
			const currentTemplateId = currentPlan?.deployment_template?.id;
			const currentTopology: TopologyElement[] = currentPlan?.cluster_topology ?? [];

			if (!currentTemplateId) {
				throw new McpError(
					ErrorCode.InternalError,
					`[${TOOL_NAME}] Could not determine current hardware profile: plan_info.current.plan.deployment_template.id is absent. Try fetching with elasticsearch_cloud_get_deployment and show_plans=true to inspect the raw plan.`,
				);
			}

			// Fetch current template name + actual billing rate in parallel
			const [currentTemplate, billingRate] = await Promise.all([
				cloudClient.get<DeploymentTemplate>(`/api/v1/deployments/templates/${encodeURIComponent(currentTemplateId)}`, {
					query: { region: params.region },
				}),
				orgId ? resolveRatePerGbRamHour(cloudClient, params.deployment_id, orgId) : Promise.resolve(null),
			]);

			const targetTopology: TopologyElement[] =
				targetTemplate.deployment_template?.resources?.elasticsearch?.[0]?.plan?.cluster_topology ?? [];

			const currentGbRamZones = totalGbRamZones(currentTopology);
			const targetGbRamZones = totalGbRamZones(targetTopology);

			const isSameProfile = currentTemplateId === params.target_template_id;

			const result = {
				deployment_id: params.deployment_id,
				deployment_name: deployment.name ?? null,
				region: params.region,
				current_profile: {
					template_id: currentTemplateId,
					name: currentTemplate.name ?? null,
					total_gb_ram_zones: Math.round(currentGbRamZones * 100) / 100,
					elasticsearch_topology: summariseTopology(currentTopology),
				},
				target_profile: {
					template_id: params.target_template_id,
					name: targetTemplate.name ?? null,
					total_gb_ram_zones: Math.round(targetGbRamZones * 100) / 100,
					elasticsearch_topology: summariseTopology(targetTopology),
					note: "Sizes shown are the target profile's defaults. Actual sizes after migration depend on your chosen configuration.",
				},
				cost_estimate: buildCostEstimate(
					currentGbRamZones,
					targetGbRamZones,
					billingRate,
					cloudClient.pricePerGbRamHour,
				),
				compatibility: {
					same_profile: isSameProfile,
					note: isSameProfile
						? "Target profile matches current — no profile migration needed."
						: "Profile migration requires updating the deployment plan via the Elastic Cloud console or the Deployment Update API. This tool only simulates; it does not apply changes.",
				},
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
			title: "Elastic Cloud: simulate hardware profile change",
			description:
				"Simulate switching a deployment to a different hardware profile (deployment template) and estimate the monthly ECU cost delta. Fetches the deployment's current plan topology and the target profile's default sizes. Rate source priority: (1) actual ECU/GB-RAM-hour from this deployment's billing history (last 30 days, requires org_id / EC_DEFAULT_ORG_ID), (2) EC_PRICE_PER_GB_RAM_HOUR env var as manual fallback. The rate_source field in the response tells you which was used. This tool is read-only and does NOT apply any changes. region must use the Elastic internal format, e.g. 'aws-eu-central-1'.",
			inputSchema: validator.shape,
		},
		handler,
	);
};

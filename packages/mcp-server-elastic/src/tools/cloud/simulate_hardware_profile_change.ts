// src/tools/cloud/simulate_hardware_profile_change.ts

import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { CloudClient } from "../../clients/cloudClient.js";
import { logger } from "../../utils/logger.js";
import type { CloudToolRegistrationFunction, SearchResult, TextContent } from "../types.js";

const TOOL_NAME = "elasticsearch_cloud_simulate_hardware_profile_change";

// 730 hours/month (365 * 24 / 12)
const HOURS_PER_MONTH = 730;

// SIO-824 D5: region must include cloud-provider prefix (e.g. 'aws-eu-central-1', not 'eu-central-1').
const REGION_PREFIX_RE = /^(aws|gcp|azure)-/;

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
		.regex(
			REGION_PREFIX_RE,
			"Region must start with 'aws-', 'gcp-', or 'azure-' (e.g. 'aws-eu-central-1'). Use elasticsearch_cloud_list_hardware_profiles to find valid regions.",
		)
		.describe("Elastic Cloud region string, e.g. 'aws-eu-central-1'. Must match the deployment's region."),
	org_id: z
		.string()
		.min(1)
		.optional()
		.describe(
			"Elastic Cloud organisation ID. Falls back to EC_DEFAULT_ORG_ID. Required to look up actual per-IC billing rates from this deployment's invoice history.",
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
	id?: string;
	region?: string;
	info?: { plan_info?: EsResourcePlanInfo };
}

interface Deployment {
	id?: string;
	name?: string;
	resources?: { elasticsearch?: EsResource[] };
}

// Real /costs/instances response shape (verified against live API for org 2461430096):
//   {
//     total_ecu: number,
//     instances: [
//       {
//         id: "<es-resource-id>",          // billing key; equals deployment.resources.elasticsearch[0].id
//         name: string,                    // sometimes deployment alias, sometimes a sibling resource id
//         type: "deployment" | ...,
//         total_ecu: number,
//         product_line_items: [
//           { sku, name, kind: "elasticsearch"|"apm"|"kibana"|null, type: "capacity",
//             unit: "hour", quantity: { value, formatted_value },
//             rate:     { value, formatted_value }, total_ecu }
//         ]
//       }
//     ]
//   }
interface BillingRateAmount {
	value?: number;
	formatted_value?: string;
}

interface BillingQuantity {
	value?: number;
	formatted_value?: string;
}

interface BillingProductLineItem {
	name?: string;
	sku?: string;
	kind?: string | null;
	type?: string;
	unit?: string;
	quantity?: BillingQuantity;
	rate?: BillingRateAmount;
	total_ecu?: number;
}

interface BillingInstanceRow {
	id?: string;
	name?: string;
	type?: string;
	total_ecu?: number;
	product_line_items?: BillingProductLineItem[];
}

interface BillingInstancesResponse {
	total_ecu?: number;
	instances?: BillingInstanceRow[];
}

// ----- SKU parsing -----

// SKU format observed in production: Cloud-Enterprise_<ic>_<region>_<size_mb>_<zone_count>
// e.g. "Cloud-Enterprise_aws.es.datahot.i3_aws-eu-central-1_15360_3"
// Region segment contains hyphens (aws-eu-central-1). IC contains dots (aws.es.datahot.i3).
const SKU_RE = /^Cloud-Enterprise_(?<ic>[^_]+)_(?<region>[^_]+(?:-[^_]+)*)_(?<size>\d+)_(?<zones>\d+)$/;

interface ParsedSku {
	ic: string;
	sizeMb: number;
	zoneCount: number;
}

function parseSku(sku: string | undefined): ParsedSku | null {
	if (!sku) return null;
	const m = SKU_RE.exec(sku);
	if (!m?.groups) return null;
	const sizeMb = Number.parseInt(m.groups.size ?? "", 10);
	const zoneCount = Number.parseInt(m.groups.zones ?? "", 10);
	if (!Number.isFinite(sizeMb) || sizeMb <= 0 || !Number.isFinite(zoneCount) || zoneCount <= 0) return null;
	return { ic: m.groups.ic ?? "", sizeMb, zoneCount };
}

// Elastic's billing SKUs include the resolved instance-size class as a trailing dotted
// segment (e.g. SKU "aws.es.master.c5d.2" while the deployment topology stores the
// family form "aws.es.master.c5d"). Normalize both sides by stripping trailing numeric
// segments so the rate map lookup matches across the naming variants.
function normalizeIc(ic: string | null | undefined): string {
	if (!ic) return "";
	return ic.replace(/(\.\d+)+$/, "");
}

// ----- Per-IC rate map -----

// Build a map of instance_configuration_id -> ECU/GB-RAM-hour from the billing row's
// elasticsearch line items. Each line item's rate.value is the per-hour rate for the
// (IC, size, zone_count) combination; dividing by (gb × zones) gives the per-GB-RAM-hour
// unit rate that's invariant across plan sizes within the same IC. When multiple line
// items exist for the same IC (e.g. the deployment was resized mid-window), we quantity-
// weight the average so longer-running configurations dominate.
function buildIcRateMap(items: BillingProductLineItem[] | undefined): Map<string, number> {
	const num = new Map<string, number>(); // sum of rate.value × hours
	const den = new Map<string, number>(); // sum of gb_ram_zones × hours
	for (const item of items ?? []) {
		if (item.kind !== "elasticsearch") continue;
		const rate = item.rate?.value;
		if (typeof rate !== "number" || rate <= 0) continue;
		const parsed = parseSku(item.sku);
		if (!parsed) continue;
		const hours = item.quantity?.value;
		if (typeof hours !== "number" || hours <= 0) continue;
		const gbRamZones = (parsed.sizeMb / 1024) * parsed.zoneCount;
		if (gbRamZones <= 0) continue;
		const key = normalizeIc(parsed.ic);
		num.set(key, (num.get(key) ?? 0) + rate * hours);
		den.set(key, (den.get(key) ?? 0) + gbRamZones * hours);
	}
	const result = new Map<string, number>();
	for (const [ic, n] of num.entries()) {
		const d = den.get(ic);
		if (d && d > 0) result.set(ic, n / d);
	}
	return result;
}

// SIO-824 D2: surface billing-call HTTP status so callers can distinguish 403 (org_id
// wrong / no access) from "no billing history in window". A 403 from the billing list
// endpoint looks identical to an empty result otherwise.
interface IcRateMapResult {
	map: Map<string, number> | null;
	// "ok": billing call succeeded and matched a row for this resource (map may still be empty if no ES line items)
	// "no_match": call succeeded but no row matched esResourceId
	// "empty": call succeeded but instances[] empty
	// "error:<status>" / "error:network": call failed
	status: string;
}

// Fetch the billing row for this ES-resource id and return its per-IC rate map.
// Returns { map: null, status: "..." } when the billing call fails or finds no row.
async function resolveIcRateMap(
	cloudClient: CloudClient,
	orgId: string,
	esResourceId: string,
	fromStr: string,
	toStr: string,
): Promise<IcRateMapResult> {
	try {
		const rows = await cloudClient.get<BillingInstancesResponse>(
			`/api/v2/billing/organizations/${encodeURIComponent(orgId)}/costs/instances`,
			{ query: { from: fromStr, to: toStr }, notFoundOk: true },
		);
		if (!rows) return { map: null, status: "empty" };
		const instances = rows.instances ?? [];
		if (instances.length === 0) return { map: null, status: "empty" };
		const match = instances.find((r) => r.id === esResourceId);
		if (!match) return { map: null, status: "no_match" };
		const map = buildIcRateMap(match.product_line_items);
		return { map: map.size > 0 ? map : null, status: "ok" };
	} catch (err) {
		if (err instanceof McpError) {
			const data = err.data as { status?: number } | undefined;
			if (typeof data?.status === "number") return { map: null, status: `error:${data.status}` };
		}
		return { map: null, status: "error:network" };
	}
}

// ----- Topology helpers -----

function mbToGb(value?: number, resource?: string): number {
	if (!value || resource?.toLowerCase() !== "memory") return 0;
	return value / 1024;
}

// Project the deployment's actual per-tier sizes onto the target profile (SIO-823).
// Tiers matched by instance_configuration_id (preferred) or topology id are emitted
// with the current tier's size + zone_count but tagged with the target tier's IC id.
// Tiers absent from the target profile are kept verbatim and recorded in warnings,
// so the cost projection reflects what would actually be billed after migration.
function projectCurrentSizesOntoTarget(
	currentTopology: TopologyElement[],
	targetTopology: TopologyElement[],
): { projected: TopologyElement[]; warnings: string[] } {
	const projected: TopologyElement[] = [];
	const warnings: string[] = [];
	for (const cur of currentTopology) {
		const match =
			targetTopology.find(
				(t) => !!cur.instance_configuration_id && t.instance_configuration_id === cur.instance_configuration_id,
			) ?? targetTopology.find((t) => !!cur.id && t.id === cur.id);
		if (match) {
			projected.push({
				...cur,
				instance_configuration_id: match.instance_configuration_id ?? cur.instance_configuration_id,
			});
		} else {
			projected.push(cur);
			const label = cur.id ?? cur.instance_configuration_id ?? "unknown";
			warnings.push(`tier '${label}' is not defined in target profile; cost projected at current sizing`);
		}
	}
	return { projected, warnings };
}

// ----- Per-tier pricing -----

interface PricedTier {
	topology_id: string | null;
	instance_configuration_id: string | null;
	size_gb_ram: number;
	zone_count: number;
	monthly_gb_ram_zones: number;
	rate_per_gb_ram_hour: number | null;
	monthly_ecu: number | null;
	rate_source: string;
}

interface PricedTopology {
	tiers: PricedTier[];
	// Full total: null when at least one *sized* tier could not be priced (rate missing).
	// Autoscaled-down tiers (size_gb_ram === 0) contribute 0 and never poison the total.
	total_monthly_ecu: number | null;
	// Partial total: sum of priced tiers only, ignoring unpriced sized tiers.
	// Always a finite number (>= 0). Lets callers reason about "most of the cost".
	total_monthly_ecu_partial: number;
	// true iff every sized tier was priced (i.e. total_monthly_ecu === total_monthly_ecu_partial).
	total_monthly_ecu_complete: boolean;
	total_gb_ram_zones: number;
	unmatched_ics: string[];
}

function round2(n: number): number {
	return Math.round(n * 100) / 100;
}

function priceTopology(
	topology: TopologyElement[],
	icRateMap: Map<string, number> | null,
	fallbackScalarRate: number | undefined,
): PricedTopology {
	const tiers: PricedTier[] = [];
	const unmatched: string[] = [];
	let partial = 0;
	let complete = true;
	let totalGbRamZones = 0;
	for (const t of topology) {
		const gb = mbToGb(t.size?.value, t.size?.resource);
		const zones = t.zone_count ?? 1;
		const gbRamZones = gb * zones;
		totalGbRamZones += gbRamZones;
		const ic = t.instance_configuration_id ?? null;
		const icKey = normalizeIc(ic);
		const icRate = icKey && icRateMap?.get(icKey);
		let rate: number | null = null;
		let source = "unavailable";

		// SIO-824 D1: a tier with size 0 (autoscaled down) is an explicit zero-cost
		// contribution, not "unavailable" — we're not paying for it right now. Skip
		// the rate lookup entirely so a missing rate doesn't poison the total.
		if (gbRamZones === 0) {
			rate = null;
			source = "size 0 (autoscaled down)";
		} else if (icRate && icRate > 0) {
			rate = icRate;
			source = `billing API: per-IC rate for ${ic}`;
		} else if (fallbackScalarRate && fallbackScalarRate > 0) {
			rate = fallbackScalarRate;
			source = "EC_PRICE_PER_GB_RAM_HOUR env var";
			if (ic) unmatched.push(ic);
		} else {
			if (ic) unmatched.push(ic);
		}

		// Monthly ECU: explicit 0 for autoscaled-down tiers, computed value when rated,
		// null when sized-but-unrated (which also flips total_complete to false).
		let monthly: number | null;
		if (gbRamZones === 0) {
			monthly = 0;
		} else if (rate !== null) {
			monthly = gbRamZones * rate * HOURS_PER_MONTH;
		} else {
			monthly = null;
			complete = false;
		}

		if (monthly !== null) partial += monthly;

		tiers.push({
			topology_id: t.id ?? null,
			instance_configuration_id: ic,
			size_gb_ram: gb,
			zone_count: zones,
			monthly_gb_ram_zones: gbRamZones,
			rate_per_gb_ram_hour: rate !== null ? Math.round(rate * 1e6) / 1e6 : null,
			monthly_ecu: monthly !== null ? round2(monthly) : null,
			rate_source: source,
		});
	}
	return {
		tiers,
		total_monthly_ecu: complete ? round2(partial) : null,
		total_monthly_ecu_partial: round2(partial),
		total_monthly_ecu_complete: complete,
		total_gb_ram_zones: round2(totalGbRamZones),
		unmatched_ics: unmatched,
	};
}

// ----- Cost-envelope builder -----

interface CostDiagnostics {
	billing_status: string;
}

interface CostEnvelope {
	rate_per_gb_ram_hour: number | null;
	rate_source: string;
	current_monthly_ecu: number | null;
	current_monthly_ecu_partial: number;
	current_monthly_ecu_complete: boolean;
	target_monthly_ecu: number | null;
	target_monthly_ecu_partial: number;
	target_monthly_ecu_complete: boolean;
	delta_monthly_ecu: number | null;
	unmatched_current_ics: string[];
	unmatched_target_ics: string[];
	diagnostics: CostDiagnostics;
	note: string;
}

function buildCostEnvelope(
	current: PricedTopology,
	target: PricedTopology,
	icRateMap: Map<string, number> | null,
	fallbackScalarRate: number | undefined,
	billingStatus: string,
): CostEnvelope {
	// Weighted-average headline rate across the current topology (preserves the scalar
	// field that existing agent consumers may still read). Returns null when no tier priced.
	let num = 0;
	let den = 0;
	for (const tier of current.tiers) {
		if (tier.rate_per_gb_ram_hour !== null && tier.monthly_gb_ram_zones > 0) {
			num += tier.rate_per_gb_ram_hour * tier.monthly_gb_ram_zones;
			den += tier.monthly_gb_ram_zones;
		}
	}
	const headlineRate = den > 0 ? num / den : null;

	const usedBilling = icRateMap !== null && icRateMap.size > 0;
	const usedFallback = fallbackScalarRate !== undefined && fallbackScalarRate > 0;
	let source: string;
	if (usedBilling) source = "billing API (last 30 days): per-IC rates derived from instance line items";
	else if (usedFallback) source = "EC_PRICE_PER_GB_RAM_HOUR env var";
	else source = "unavailable";

	const delta =
		current.total_monthly_ecu !== null && target.total_monthly_ecu !== null
			? round2(target.total_monthly_ecu - current.total_monthly_ecu)
			: null;

	const note =
		current.total_monthly_ecu === null
			? "Some sized tiers could not be priced. See *_partial fields for the priced subset, and unmatched_current_ics / unmatched_target_ics for ICs lacking a billing match. Set EC_PRICE_PER_GB_RAM_HOUR as a fallback or ensure the deployment has billing history in the last 30 days."
			: "Per-tier ECU = size_gb × zones × per-IC rate × 730 hours. Autoscaled-down tiers (size 0) contribute 0. Headline rate is the GB-RAM-zone-weighted average across the current topology. Excludes snapshot storage, data transfer, and non-Elasticsearch tiers. Verify realised spend with elasticsearch_billing_get_deployment_costs after any plan change.";

	return {
		rate_per_gb_ram_hour: headlineRate !== null ? Math.round(headlineRate * 1e6) / 1e6 : null,
		rate_source: source,
		current_monthly_ecu: current.total_monthly_ecu,
		current_monthly_ecu_partial: current.total_monthly_ecu_partial,
		current_monthly_ecu_complete: current.total_monthly_ecu_complete,
		target_monthly_ecu: target.total_monthly_ecu,
		target_monthly_ecu_partial: target.total_monthly_ecu_partial,
		target_monthly_ecu_complete: target.total_monthly_ecu_complete,
		delta_monthly_ecu: delta,
		unmatched_current_ics: current.unmatched_ics,
		unmatched_target_ics: target.unmatched_ics,
		diagnostics: { billing_status: billingStatus },
		note,
	};
}

// SIO-824 D4: map deployment-fetch 403/404 to a human-readable McpError. Elastic Cloud
// returns 403 for unknown deployment_ids (not 404), and the raw "Forbidden" message
// reads like an auth problem to users.
async function fetchDeployment(cloudClient: CloudClient, deploymentId: string): Promise<Deployment> {
	try {
		return await cloudClient.get<Deployment>(`/api/v1/deployments/${encodeURIComponent(deploymentId)}`, {
			query: { show_plans: true },
		});
	} catch (err) {
		if (err instanceof McpError) {
			const data = err.data as { status?: number } | undefined;
			if (data?.status === 403 || data?.status === 404) {
				throw new McpError(
					ErrorCode.InvalidParams,
					`[${TOOL_NAME}] Deployment '${deploymentId}' not found or not accessible with the current EC_API_KEY. Use elasticsearch_cloud_list_deployments to find valid IDs.`,
					{ status: data.status, deployment_id: deploymentId },
				);
			}
		}
		throw err;
	}
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

			// 30-day billing window. v2 billing API requires full ISO 8601 timestamps;
			// date-only strings (YYYY-MM-DD) return 400.
			const toDate = new Date();
			const fromDate = new Date(toDate.getTime() - 30 * 24 * 60 * 60 * 1000);
			const fromStr = fromDate.toISOString();
			const toStr = toDate.toISOString();

			const [deployment, targetTemplate] = await Promise.all([
				fetchDeployment(cloudClient, params.deployment_id),
				cloudClient.get<DeploymentTemplate>(
					`/api/v1/deployments/templates/${encodeURIComponent(params.target_template_id)}`,
					{ query: { region: params.region } },
				),
			]);

			const esResource = deployment.resources?.elasticsearch?.[0];
			const esResourceId = esResource?.id;
			const deploymentRegion = esResource?.region ?? null;
			const currentPlan = esResource?.info?.plan_info?.current?.plan;
			const currentTemplateId = currentPlan?.deployment_template?.id;
			const currentTopology: TopologyElement[] = currentPlan?.cluster_topology ?? [];

			if (!currentTemplateId) {
				throw new McpError(
					ErrorCode.InternalError,
					`[${TOOL_NAME}] Could not determine current hardware profile: plan_info.current.plan.deployment_template.id is absent. Try fetching with elasticsearch_cloud_get_deployment and show_plans=true to inspect the raw plan.`,
				);
			}

			// Per-IC rate map from billing (SIO-822); keyed on ES-resource ID, not deployment ID.
			// Run in parallel with the current-template metadata fetch.
			const [currentTemplate, rateResult] = await Promise.all([
				cloudClient.get<DeploymentTemplate>(`/api/v1/deployments/templates/${encodeURIComponent(currentTemplateId)}`, {
					query: { region: params.region },
				}),
				orgId && esResourceId
					? resolveIcRateMap(cloudClient, orgId, esResourceId, fromStr, toStr)
					: Promise.resolve<IcRateMapResult>({ map: null, status: orgId ? "no_resource_id" : "no_org_id" }),
			]);
			const icRateMap = rateResult.map;

			const targetTemplateTopology: TopologyElement[] =
				targetTemplate.deployment_template?.resources?.elasticsearch?.[0]?.plan?.cluster_topology ?? [];

			// SIO-823: project current per-tier sizes onto the target profile rather than
			// using the target template's defaults, so cost reflects what would actually run.
			const { projected: projectedTargetTopology, warnings: topologyWarnings } = projectCurrentSizesOntoTarget(
				currentTopology,
				targetTemplateTopology,
			);

			const pricedCurrent = priceTopology(currentTopology, icRateMap, cloudClient.pricePerGbRamHour);
			const pricedTarget = priceTopology(projectedTargetTopology, icRateMap, cloudClient.pricePerGbRamHour);

			const isSameProfile = currentTemplateId === params.target_template_id;

			// SIO-824 D3: report the deployment's true region as `region`, echo the caller's
			// region under `target_template_region`, and surface a warning when they diverge.
			const responseWarnings: string[] = [];
			if (deploymentRegion && deploymentRegion !== params.region) {
				responseWarnings.push(
					`region '${params.region}' does not match deployment region '${deploymentRegion}'; the target template was looked up in the supplied region but cost numbers reflect the deployment's actual region`,
				);
			}

			const result = {
				deployment_id: params.deployment_id,
				es_resource_id: esResourceId ?? null,
				deployment_name: deployment.name ?? null,
				region: deploymentRegion ?? params.region,
				target_template_region: params.region,
				warnings: responseWarnings,
				current_profile: {
					template_id: currentTemplateId,
					name: currentTemplate.name ?? null,
					total_gb_ram_zones: pricedCurrent.total_gb_ram_zones,
					elasticsearch_topology: pricedCurrent.tiers,
				},
				target_profile: {
					template_id: params.target_template_id,
					name: targetTemplate.name ?? null,
					total_gb_ram_zones: pricedTarget.total_gb_ram_zones,
					elasticsearch_topology: pricedTarget.tiers,
					topology_warnings: topologyWarnings,
					note: "Sizes shown are the deployment's current per-tier sizes projected onto the target profile. Tiers absent from the target profile are preserved verbatim and listed in topology_warnings.",
				},
				cost_estimate: buildCostEnvelope(
					pricedCurrent,
					pricedTarget,
					icRateMap,
					cloudClient.pricePerGbRamHour,
					rateResult.status,
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
				"Simulate switching a deployment to a different hardware profile (deployment template) and estimate the monthly ECU cost delta. Fetches the deployment's current plan topology and projects the per-tier sizes onto the target profile (tiers missing from the target are kept and surfaced in topology_warnings). Per-tier rates are sourced from this deployment's last-30-days billing line items, matched by instance_configuration_id (requires org_id / EC_DEFAULT_ORG_ID). Tiers without a billing match fall back to EC_PRICE_PER_GB_RAM_HOUR when set, otherwise return monthly_ecu=null with rate_source='unavailable'. Autoscaled-down tiers (size 0) contribute 0. *_partial fields expose the priced subset when some tiers can't be rated. cost_estimate.diagnostics.billing_status indicates whether billing was reachable (ok / empty / no_match / error:<http_status>). This tool is read-only and does NOT apply any changes. region must use the Elastic internal format, e.g. 'aws-eu-central-1'.",
			inputSchema: validator.shape,
		},
		handler,
	);
};

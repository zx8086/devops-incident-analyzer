// tests/unit/tools/cloud/simulate_hardware_profile_change.test.ts

import { describe, expect, test } from "bun:test";
import { unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import { CloudClient, type FetchLike } from "../../../../src/clients/cloudClient.js";
import type { ElasticCloudConfig } from "../../../../src/config/schemas.js";
import { registerCloudSimulateHardwareProfileChangeTool } from "../../../../src/tools/cloud/simulate_hardware_profile_change.js";
import { getToolFromServer } from "../../../utils/elasticsearch-client.js";

const DEPLOYMENT_ID = "deployment-abc";
const ES_RESOURCE_ID = "es-resource-xyz";
const TARGET_TEMPLATE = "aws-cpu-optimized";
const CURRENT_TEMPLATE = "aws-storage-optimized";
const REGION = "aws-eu-central-1";
const ORG_ID = "org-123";

// SKU sample: aws.es.datahot.i3 at 16 GB × 3 AZ = 48 GB-RAM-zones, rate 2.7232 -> 0.0567 ECU/GB-RAM-hour.
const HOT_IC = "aws.es.datahot.i3";
const MASTER_IC = "aws.es.master.c5d.2";
const COLD_IC = "aws.es.datacold.d3";

const baseCfg: ElasticCloudConfig = {
	apiKey: "k",
	endpoint: "https://api.elastic-cloud.com",
	requestTimeout: 5000,
	maxRetries: 0,
};

// Mirrors the real /api/v1/deployments/<id> response shape (resources.elasticsearch[0].id
// is the ES-resource ID — same value billing/list_instances rows use as `id`).
const deploymentFixture = {
	id: DEPLOYMENT_ID,
	name: "test-deployment",
	resources: {
		elasticsearch: [
			{
				ref_id: "main-elasticsearch",
				id: ES_RESOURCE_ID,
				region: REGION,
				info: {
					plan_info: {
						current: {
							plan: {
								deployment_template: { id: CURRENT_TEMPLATE },
								cluster_topology: [
									{
										id: "hot_content",
										instance_configuration_id: HOT_IC,
										size: { value: 16384, resource: "memory" }, // 16 GB
										zone_count: 3,
									},
									{
										id: "master",
										instance_configuration_id: MASTER_IC,
										size: { value: 4096, resource: "memory" }, // 4 GB
										zone_count: 3,
									},
									{
										id: "cold",
										instance_configuration_id: COLD_IC,
										size: { value: 2048, resource: "memory" }, // 2 GB
										zone_count: 2,
									},
								],
							},
						},
					},
				},
			},
		],
	},
};

// Target template defines hot + master but NOT cold (drives topology_warnings).
// Defaults are deliberately smaller than the deployment so SIO-823 has something to assert.
const targetTemplateFixture = {
	id: TARGET_TEMPLATE,
	name: "CPU Optimized",
	deployment_template: {
		resources: {
			elasticsearch: [
				{
					plan: {
						cluster_topology: [
							{
								id: "hot_content",
								instance_configuration_id: HOT_IC,
								size: { value: 8192, resource: "memory" }, // 8 GB default
								zone_count: 2,
							},
							{
								id: "master",
								instance_configuration_id: MASTER_IC,
								size: { value: 1024, resource: "memory" },
								zone_count: 3,
							},
						],
					},
				},
			],
		},
	},
};

const currentTemplateFixture = {
	id: CURRENT_TEMPLATE,
	name: "Storage Optimized",
	deployment_template: { resources: { elasticsearch: [{ plan: { cluster_topology: [] } }] } },
};

// Mirrors the real /api/v2/billing/.../costs/instances response. rate.value is hourly for
// the full (size × AZ) capacity row. Per-GB-RAM-hour = rate.value / (size_gb × zones).
// We synthesize three ES line items (one per IC the deployment uses) plus an APM and
// a Kibana row that MUST be filtered out.
const HOT_HOURLY = 2.7232; // -> 2.7232 / (16 × 3) = 0.05673 ECU/GB-RAM-hour
const MASTER_HOURLY = 1.212; // -> 1.212  / (4  × 3) = 0.101   ECU/GB-RAM-hour
const COLD_HOURLY = 0.3264; // -> 0.3264 / (2  × 2) = 0.0816  ECU/GB-RAM-hour
const APM_HOURLY = 0.81;
const KIBANA_HOURLY = 0.12;

const billingInstancesFixture = {
	total_ecu: 12345.6,
	instances: [
		{
			id: ES_RESOURCE_ID,
			name: "test-deployment",
			type: "deployment",
			total_ecu: 8000,
			product_line_items: [
				{
					name: "Cloud Enterprise, AWS eu-central-1, aws.es.datahot.i3, 16GB, 3AZ",
					sku: `Cloud-Enterprise_${HOT_IC}_${REGION}_16384_3`,
					type: "capacity",
					unit: "hour",
					quantity: { value: 720, formatted_value: "720 hours" },
					rate: { value: HOT_HOURLY, formatted_value: `${HOT_HOURLY} per hour` },
					kind: "elasticsearch",
					total_ecu: HOT_HOURLY * 720,
				},
				{
					name: "Cloud Enterprise, AWS eu-central-1, aws.es.master.c5d.2, 4GB, 3AZ",
					sku: `Cloud-Enterprise_${MASTER_IC}_${REGION}_4096_3`,
					type: "capacity",
					unit: "hour",
					quantity: { value: 720, formatted_value: "720 hours" },
					rate: { value: MASTER_HOURLY, formatted_value: `${MASTER_HOURLY} per hour` },
					kind: "elasticsearch",
					total_ecu: MASTER_HOURLY * 720,
				},
				{
					name: "Cloud Enterprise, AWS eu-central-1, aws.es.datacold.d3, 2GB, 2AZ",
					sku: `Cloud-Enterprise_${COLD_IC}_${REGION}_2048_2`,
					type: "capacity",
					unit: "hour",
					quantity: { value: 720, formatted_value: "720 hours" },
					rate: { value: COLD_HOURLY, formatted_value: `${COLD_HOURLY} per hour` },
					kind: "elasticsearch",
					total_ecu: COLD_HOURLY * 720,
				},
				// Non-ES line items must be filtered out by buildIcRateMap.
				{
					name: "Cloud Enterprise, AWS eu-central-1, aws.integrationsserver.c6gd.2, 4GB, 3AZ",
					sku: "Cloud-Enterprise_aws.integrationsserver.c6gd.2_aws-eu-central-1_4096_3",
					type: "capacity",
					unit: "hour",
					quantity: { value: 720, formatted_value: "720 hours" },
					rate: { value: APM_HOURLY, formatted_value: `${APM_HOURLY} per hour` },
					kind: "apm",
					total_ecu: APM_HOURLY * 720,
				},
				{
					name: "Cloud Enterprise, AWS eu-central-1, aws.kibana.c5d.2, 1GB, 1AZ",
					sku: "Cloud-Enterprise_aws.kibana.c5d.2_aws-eu-central-1_1024_1",
					type: "capacity",
					unit: "hour",
					quantity: { value: 720, formatted_value: "720 hours" },
					rate: { value: KIBANA_HOURLY, formatted_value: `${KIBANA_HOURLY} per hour` },
					kind: "kibana",
					total_ecu: KIBANA_HOURLY * 720,
				},
			],
		},
	],
};

interface CallLog {
	url: string;
	pathname: string;
}

function makeFetch(
	handlers: Record<string, (u: URL) => { status?: number; body?: unknown } | unknown | null>,
	log: CallLog[],
): FetchLike {
	return async (u) => {
		const url = new URL(String(u));
		log.push({ url: String(u), pathname: url.pathname });
		// Order longest prefix first so /costs/instances/<id>/items matches before /costs/instances
		const sortedPrefixes = Object.keys(handlers).sort((a, b) => b.length - a.length);
		for (const prefix of sortedPrefixes) {
			if (url.pathname.startsWith(prefix)) {
				const body = handlers[prefix]?.(url);
				if (body === null) return new Response("", { status: 404 });
				// Allow handlers to return { status, body } for non-200 responses.
				if (
					body !== undefined &&
					body !== null &&
					typeof body === "object" &&
					"status" in (body as object) &&
					"body" in (body as object)
				) {
					const wrapped = body as { status: number; body: unknown };
					return new Response(JSON.stringify(wrapped.body ?? {}), { status: wrapped.status });
				}
				return new Response(JSON.stringify(body), { status: 200 });
			}
		}
		return new Response(JSON.stringify({ error: "no handler", pathname: url.pathname }), { status: 500 });
	};
}

function makeHandler(cfg: ElasticCloudConfig, fetchImpl: FetchLike) {
	const server = new McpServer({ name: "t", version: "1.0.0" });
	registerCloudSimulateHardwareProfileChangeTool(server, new CloudClient(cfg, fetchImpl));
	const tool = getToolFromServer(server, "elasticsearch_cloud_simulate_hardware_profile_change");
	if (!tool) throw new Error("tool not registered");
	return tool.handler as (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;
}

interface ResultEnvelope {
	region: string;
	target_template_region: string;
	warnings: string[];
	current_profile: { elasticsearch_topology: Tier[]; total_gb_ram_zones: number };
	target_profile: { elasticsearch_topology: Tier[]; total_gb_ram_zones: number; topology_warnings: string[] };
	cost_estimate: {
		rate_per_gb_ram_hour: number | null;
		rate_source: string;
		rate_source_confidence: "billed_actual" | "mixed" | "fallback_only" | "unavailable";
		current_monthly_ecu: number | null;
		current_monthly_ecu_priced_tiers_subtotal: number;
		current_monthly_ecu_priced_tier_topology_ids: string[];
		current_monthly_ecu_complete: boolean;
		target_monthly_ecu: number | null;
		target_monthly_ecu_priced_tiers_subtotal: number;
		target_monthly_ecu_priced_tier_topology_ids: string[];
		target_monthly_ecu_complete: boolean;
		delta_monthly_ecu: number | null;
		unmatched_current_ics: string[];
		unmatched_target_ics: string[];
		diagnostics: { billing_status: string };
		note: string;
	};
	compatibility: { same_profile: boolean; note: string };
}

interface Tier {
	topology_id: string | null;
	instance_configuration_id: string | null;
	size_gb_ram: number;
	zone_count: number;
	monthly_gb_ram_zones: number;
	rate_per_gb_ram_hour: number | null;
	monthly_ecu: number | null;
	rate_source: string;
}

function parseResult(envelope: { content: Array<{ text: string }> }): ResultEnvelope {
	return JSON.parse(envelope.content[0]?.text ?? "{}") as ResultEnvelope;
}

const defaultHandlers = {
	[`/api/v1/deployments/${DEPLOYMENT_ID}`]: () => deploymentFixture,
	[`/api/v1/deployments/templates/${TARGET_TEMPLATE}`]: () => targetTemplateFixture,
	[`/api/v1/deployments/templates/${CURRENT_TEMPLATE}`]: () => currentTemplateFixture,
	[`/api/v2/billing/organizations/${ORG_ID}/costs/instances`]: () => billingInstancesFixture,
};

const HOURS_PER_MONTH = 730;
const HOT_RATE_PER_GB_RAM_HOUR = HOT_HOURLY / (16 * 3);
const MASTER_RATE_PER_GB_RAM_HOUR = MASTER_HOURLY / (4 * 3);
const COLD_RATE_PER_GB_RAM_HOUR = COLD_HOURLY / (2 * 2);

describe("elasticsearch_cloud_simulate_hardware_profile_change", () => {
	test("SIO-822: billing call uses the /costs/instances list endpoint (no /items, ES-resource id never confused with deployment id)", async () => {
		const log: CallLog[] = [];
		const handler = makeHandler({ ...baseCfg, defaultOrgId: ORG_ID }, makeFetch(defaultHandlers, log));

		await handler({ deployment_id: DEPLOYMENT_ID, target_template_id: TARGET_TEMPLATE, region: REGION });

		const billingCalls = log.filter((c) => c.pathname.startsWith("/api/v2/billing/"));
		expect(billingCalls.length).toBe(1);
		expect(billingCalls[0]?.pathname.endsWith("/items")).toBe(false);
		expect(billingCalls[0]?.pathname).toBe(`/api/v2/billing/organizations/${ORG_ID}/costs/instances`);
		for (const c of billingCalls) expect(c.pathname).not.toContain(DEPLOYMENT_ID);
	});

	test("SIO-822: rate.value object unwraps; hot tier shows correct per-GB-RAM-hour", async () => {
		const handler = makeHandler({ ...baseCfg, defaultOrgId: ORG_ID }, makeFetch(defaultHandlers, []));
		const result = parseResult(
			await handler({ deployment_id: DEPLOYMENT_ID, target_template_id: TARGET_TEMPLATE, region: REGION }),
		);
		const hot = result.current_profile.elasticsearch_topology.find((t) => t.instance_configuration_id === HOT_IC);
		expect(hot).toBeDefined();
		expect(hot?.rate_per_gb_ram_hour).toBeCloseTo(HOT_RATE_PER_GB_RAM_HOUR, 6);
		expect(hot?.rate_source).toContain("billing API: per-IC rate");
		expect(hot?.monthly_ecu).not.toBeNull();
		expect(typeof result.cost_estimate.rate_per_gb_ram_hour).toBe("number");
	});

	test("per-IC rates differ across tiers (single scalar would be wrong)", async () => {
		const handler = makeHandler({ ...baseCfg, defaultOrgId: ORG_ID }, makeFetch(defaultHandlers, []));
		const result = parseResult(
			await handler({ deployment_id: DEPLOYMENT_ID, target_template_id: TARGET_TEMPLATE, region: REGION }),
		);
		const tiers = result.current_profile.elasticsearch_topology;
		const hotRate = tiers.find((t) => t.instance_configuration_id === HOT_IC)?.rate_per_gb_ram_hour;
		const masterRate = tiers.find((t) => t.instance_configuration_id === MASTER_IC)?.rate_per_gb_ram_hour;
		expect(hotRate).toBeCloseTo(HOT_RATE_PER_GB_RAM_HOUR, 6);
		expect(masterRate).toBeCloseTo(MASTER_RATE_PER_GB_RAM_HOUR, 6);
		expect(hotRate).not.toBe(masterRate);
	});

	test("non-Elasticsearch line items (apm, kibana) are filtered out of rate map", async () => {
		const handler = makeHandler({ ...baseCfg, defaultOrgId: ORG_ID }, makeFetch(defaultHandlers, []));
		const result = parseResult(
			await handler({ deployment_id: DEPLOYMENT_ID, target_template_id: TARGET_TEMPLATE, region: REGION }),
		);
		const apmPerGbRamHour = APM_HOURLY / (4 * 3); // ~0.0675
		for (const t of result.current_profile.elasticsearch_topology) {
			expect(t.rate_per_gb_ram_hour).not.toBe(apmPerGbRamHour);
		}
		expect(result.cost_estimate.rate_source).not.toContain("apm");
		expect(result.cost_estimate.rate_source).not.toContain("kibana");
	});

	test("current_monthly_ecu equals sum of per-tier ECUs", async () => {
		const handler = makeHandler({ ...baseCfg, defaultOrgId: ORG_ID }, makeFetch(defaultHandlers, []));
		const result = parseResult(
			await handler({ deployment_id: DEPLOYMENT_ID, target_template_id: TARGET_TEMPLATE, region: REGION }),
		);
		const expected =
			16 * 3 * HOT_RATE_PER_GB_RAM_HOUR * HOURS_PER_MONTH +
			4 * 3 * MASTER_RATE_PER_GB_RAM_HOUR * HOURS_PER_MONTH +
			2 * 2 * COLD_RATE_PER_GB_RAM_HOUR * HOURS_PER_MONTH;
		expect(result.cost_estimate.current_monthly_ecu).toBeCloseTo(Math.round(expected * 100) / 100, 1);
	});

	test("SIO-823: target uses current actual sizes, not template defaults", async () => {
		const handler = makeHandler({ ...baseCfg, defaultOrgId: ORG_ID }, makeFetch(defaultHandlers, []));
		const result = parseResult(
			await handler({ deployment_id: DEPLOYMENT_ID, target_template_id: TARGET_TEMPLATE, region: REGION }),
		);
		const hot = result.target_profile.elasticsearch_topology.find((t) => t.instance_configuration_id === HOT_IC);
		expect(hot?.size_gb_ram).toBe(16);
		expect(hot?.zone_count).toBe(3);
	});

	test("SIO-823: tier absent from target appears in topology_warnings", async () => {
		const handler = makeHandler({ ...baseCfg, defaultOrgId: ORG_ID }, makeFetch(defaultHandlers, []));
		const result = parseResult(
			await handler({ deployment_id: DEPLOYMENT_ID, target_template_id: TARGET_TEMPLATE, region: REGION }),
		);
		expect(result.target_profile.topology_warnings.some((w) => w.includes("'cold'"))).toBe(true);
	});

	test("SIO-823: target cost reflects projected sizing × per-IC rates", async () => {
		const handler = makeHandler({ ...baseCfg, defaultOrgId: ORG_ID }, makeFetch(defaultHandlers, []));
		const result = parseResult(
			await handler({ deployment_id: DEPLOYMENT_ID, target_template_id: TARGET_TEMPLATE, region: REGION }),
		);
		expect(result.cost_estimate.target_monthly_ecu).toBe(result.cost_estimate.current_monthly_ecu);
		expect(result.cost_estimate.delta_monthly_ecu).toBe(0);
	});

	test("env-var fallback prices tiers whose IC is absent from billing", async () => {
		const noColdBilling = {
			...billingInstancesFixture,
			instances: [
				{
					...billingInstancesFixture.instances[0],
					product_line_items: billingInstancesFixture.instances[0]?.product_line_items?.filter(
						(li) => !li.sku?.includes(COLD_IC),
					),
				},
			],
		};
		const handlers = {
			...defaultHandlers,
			[`/api/v2/billing/organizations/${ORG_ID}/costs/instances`]: () => noColdBilling,
		};
		const handler = makeHandler({ ...baseCfg, defaultOrgId: ORG_ID, pricePerGbRamHour: 0.05 }, makeFetch(handlers, []));
		const result = parseResult(
			await handler({ deployment_id: DEPLOYMENT_ID, target_template_id: TARGET_TEMPLATE, region: REGION }),
		);
		const cold = result.current_profile.elasticsearch_topology.find((t) => t.instance_configuration_id === COLD_IC);
		expect(cold?.rate_per_gb_ram_hour).toBeCloseTo(0.05, 6);
		expect(cold?.rate_source).toBe("EC_PRICE_PER_GB_RAM_HOUR env var");
		// SIO-824 D7: cold IC appears in unmatched_current_ics (current uses cold). Target also
		// inherits the cold tier via projection (since target template lacks cold the current
		// tier is kept verbatim), so cold ends up in unmatched_target_ics too — but the lists
		// are now separately addressable.
		expect(result.cost_estimate.unmatched_current_ics).toContain(COLD_IC);
		expect(result.cost_estimate.unmatched_target_ics).toContain(COLD_IC);
	});

	test("pure env-var path: no org_id, no billing calls, every tier prices at scalar rate", async () => {
		const log: CallLog[] = [];
		const handler = makeHandler({ ...baseCfg, pricePerGbRamHour: 0.05 }, makeFetch(defaultHandlers, log));
		const result = parseResult(
			await handler({ deployment_id: DEPLOYMENT_ID, target_template_id: TARGET_TEMPLATE, region: REGION }),
		);
		for (const t of result.current_profile.elasticsearch_topology) {
			expect(t.rate_per_gb_ram_hour).toBeCloseTo(0.05, 6);
			expect(t.rate_source).toBe("EC_PRICE_PER_GB_RAM_HOUR env var");
		}
		expect(log.filter((c) => c.pathname.startsWith("/api/v2/billing/")).length).toBe(0);
		expect(result.cost_estimate.rate_source).toBe("EC_PRICE_PER_GB_RAM_HOUR env var");
		// SIO-824 D2: when no org_id is configured the billing_status surfaces the reason.
		expect(result.cost_estimate.diagnostics.billing_status).toBe("no_org_id");
	});

	test("unavailable path: no org_id, no fallback, returns null cost with valid envelope", async () => {
		const handler = makeHandler(baseCfg, makeFetch(defaultHandlers, []));
		const result = parseResult(
			await handler({ deployment_id: DEPLOYMENT_ID, target_template_id: TARGET_TEMPLATE, region: REGION }),
		);
		expect(result.cost_estimate.rate_source).toBe("unavailable");
		expect(result.cost_estimate.current_monthly_ecu).toBeNull();
		expect(result.cost_estimate.target_monthly_ecu).toBeNull();
		expect(result.cost_estimate.delta_monthly_ecu).toBeNull();
		expect(result.cost_estimate.rate_per_gb_ram_hour).toBeNull();
		expect(result.current_profile.elasticsearch_topology.length).toBe(3);
		// SIO-824 D2: billing_status surfaces "no_org_id" in the unavailable path.
		expect(result.cost_estimate.diagnostics.billing_status).toBe("no_org_id");
	});

	test("billing 404 / empty row: graceful degradation with env-var fallback", async () => {
		const handlers = {
			...defaultHandlers,
			[`/api/v2/billing/organizations/${ORG_ID}/costs/instances`]: () => ({ total_ecu: 0, instances: [] }),
		};
		const handler = makeHandler({ ...baseCfg, defaultOrgId: ORG_ID, pricePerGbRamHour: 0.05 }, makeFetch(handlers, []));
		const result = parseResult(
			await handler({ deployment_id: DEPLOYMENT_ID, target_template_id: TARGET_TEMPLATE, region: REGION }),
		);
		expect(result.cost_estimate.rate_source).toBe("EC_PRICE_PER_GB_RAM_HOUR env var");
		expect(result.cost_estimate.current_monthly_ecu).not.toBeNull();
		for (const t of result.current_profile.elasticsearch_topology) {
			expect(t.rate_per_gb_ram_hour).toBeCloseTo(0.05, 6);
		}
		// SIO-824 D2: empty billing instances surface as "empty" status.
		expect(result.cost_estimate.diagnostics.billing_status).toBe("empty");
	});

	test("same_profile short-circuit: target equals current when template ids match", async () => {
		const handler = makeHandler({ ...baseCfg, defaultOrgId: ORG_ID }, makeFetch(defaultHandlers, []));
		const result = parseResult(
			await handler({ deployment_id: DEPLOYMENT_ID, target_template_id: CURRENT_TEMPLATE, region: REGION }),
		);
		expect(result.compatibility.same_profile).toBe(true);
		expect(result.target_profile.topology_warnings.length).toBe(3);
		expect(result.target_profile.total_gb_ram_zones).toBe(result.current_profile.total_gb_ram_zones);
	});

	test("missing currentTemplateId still throws InternalError (existing guard)", async () => {
		const broken = {
			id: DEPLOYMENT_ID,
			name: "broken-deployment",
			resources: {
				elasticsearch: [{ id: ES_RESOURCE_ID, region: REGION, info: { plan_info: { current: { plan: {} } } } }],
			},
		};
		const handlers = { ...defaultHandlers, [`/api/v1/deployments/${DEPLOYMENT_ID}`]: () => broken };
		const handler = makeHandler({ ...baseCfg, defaultOrgId: ORG_ID }, makeFetch(handlers, []));
		await expect(
			handler({ deployment_id: DEPLOYMENT_ID, target_template_id: TARGET_TEMPLATE, region: REGION }),
		).rejects.toBeInstanceOf(McpError);
	});

	test("billing SKU with .N size-class suffix matches bare-family topology IC", async () => {
		const masterSuffixedSku = `Cloud-Enterprise_aws.es.master.c5d.2_${REGION}_4096_3`;
		const billing = {
			...billingInstancesFixture,
			instances: [
				{
					...billingInstancesFixture.instances[0],
					product_line_items: [
						{
							name: "Cloud Enterprise, aws.es.master.c5d.2, 4GB, 3AZ",
							sku: masterSuffixedSku,
							type: "capacity",
							unit: "hour",
							quantity: { value: 720, formatted_value: "720 hours" },
							rate: { value: MASTER_HOURLY, formatted_value: `${MASTER_HOURLY} per hour` },
							kind: "elasticsearch",
							total_ecu: MASTER_HOURLY * 720,
						},
					],
				},
			],
		};
		const handlers = {
			...defaultHandlers,
			[`/api/v2/billing/organizations/${ORG_ID}/costs/instances`]: () => billing,
		};
		const handler = makeHandler({ ...baseCfg, defaultOrgId: ORG_ID }, makeFetch(handlers, []));
		const result = parseResult(
			await handler({ deployment_id: DEPLOYMENT_ID, target_template_id: TARGET_TEMPLATE, region: REGION }),
		);
		const master = result.current_profile.elasticsearch_topology.find((t) => t.instance_configuration_id === MASTER_IC);
		expect(master?.rate_per_gb_ram_hour).toBeCloseTo(MASTER_RATE_PER_GB_RAM_HOUR, 6);
		expect(master?.rate_source).toContain("billing API: per-IC rate");
	});

	test("validation: empty deployment_id is rejected", async () => {
		const handler = makeHandler(baseCfg, makeFetch(defaultHandlers, []));
		await expect(
			handler({ deployment_id: "", target_template_id: TARGET_TEMPLATE, region: REGION }),
		).rejects.toBeInstanceOf(McpError);
	});

	// ----- SIO-824 D1 + D6: autoscaled-down tiers no longer poison the total -----

	test("SIO-824 D1: tier with size 0 contributes 0 and does not null the total", async () => {
		// Mirrors eu-cld-monitor / eu-onboarding: hot tier sized, every other tier autoscaled down.
		const autoscalingDeployment = {
			id: DEPLOYMENT_ID,
			name: "autoscaling-deployment",
			resources: {
				elasticsearch: [
					{
						id: ES_RESOURCE_ID,
						region: REGION,
						info: {
							plan_info: {
								current: {
									plan: {
										deployment_template: { id: CURRENT_TEMPLATE },
										cluster_topology: [
											{
												id: "hot_content",
												instance_configuration_id: HOT_IC,
												size: { value: 16384, resource: "memory" },
												zone_count: 3,
											},
											// Autoscaled-down tiers: rate may or may not exist in billing, but size 0
											// means we're not paying — these must contribute 0, not null.
											{
												id: "master",
												instance_configuration_id: MASTER_IC,
												size: { value: 0, resource: "memory" },
												zone_count: 3,
											},
											{
												id: "coordinating",
												instance_configuration_id: "aws.coordinating.m5d",
												size: { value: 0, resource: "memory" },
												zone_count: 2,
											},
											{
												id: "warm",
												instance_configuration_id: "aws.es.datawarm.d3",
												size: { value: 0, resource: "memory" },
												zone_count: 2,
											},
										],
									},
								},
							},
						},
					},
				],
			},
		};
		const handlers = { ...defaultHandlers, [`/api/v1/deployments/${DEPLOYMENT_ID}`]: () => autoscalingDeployment };
		const handler = makeHandler({ ...baseCfg, defaultOrgId: ORG_ID }, makeFetch(handlers, []));
		const result = parseResult(
			await handler({ deployment_id: DEPLOYMENT_ID, target_template_id: TARGET_TEMPLATE, region: REGION }),
		);

		// Total is a finite number (not null) because the only sized tier was priced.
		expect(result.cost_estimate.current_monthly_ecu).not.toBeNull();
		expect(result.cost_estimate.current_monthly_ecu_complete).toBe(true);
		expect(result.cost_estimate.current_monthly_ecu).toBeCloseTo(
			16 * 3 * HOT_RATE_PER_GB_RAM_HOUR * HOURS_PER_MONTH,
			1,
		);

		// Autoscaled-down tiers price at 0 with a clear source label.
		const master = result.current_profile.elasticsearch_topology.find((t) => t.topology_id === "master");
		expect(master?.monthly_ecu).toBe(0);
		expect(master?.rate_source).toBe("size 0 (autoscaled down)");
		const coord = result.current_profile.elasticsearch_topology.find((t) => t.topology_id === "coordinating");
		expect(coord?.monthly_ecu).toBe(0);
		expect(coord?.rate_source).toBe("size 0 (autoscaled down)");
	});

	test("SIO-824 D6 / SIO-825: target with sized but unmatched tier surfaces *_priced_tiers_subtotal + *_complete=false", async () => {
		// Build a deployment whose target topology adds a new tier (frozen) with size > 0
		// but no IC in the billing rate map — target should produce a non-null partial
		// but null full total.
		const targetWithFrozen = {
			id: TARGET_TEMPLATE,
			name: "CPU Optimized",
			deployment_template: {
				resources: {
					elasticsearch: [
						{
							plan: {
								cluster_topology: [
									{
										id: "hot_content",
										instance_configuration_id: HOT_IC,
										size: { value: 8192, resource: "memory" },
										zone_count: 2,
									},
									{
										id: "frozen",
										instance_configuration_id: "aws.es.datafrozen.unknown",
										size: { value: 4096, resource: "memory" },
										zone_count: 2,
									},
								],
							},
						},
					],
				},
			},
		};
		// Project-mode: the projection layer keeps the deployment's current tiers (which
		// all have rates). To exercise D6 we need a *target-only* unrated sized tier, so
		// we add it to current too with no billing entry and no env-var fallback.
		const currentWithUnrated = {
			...deploymentFixture,
			resources: {
				elasticsearch: [
					{
						...deploymentFixture.resources.elasticsearch[0],
						info: {
							plan_info: {
								current: {
									plan: {
										deployment_template: { id: CURRENT_TEMPLATE },
										cluster_topology: [
											{
												id: "hot_content",
												instance_configuration_id: HOT_IC,
												size: { value: 16384, resource: "memory" },
												zone_count: 3,
											},
											{
												id: "frozen",
												instance_configuration_id: "aws.es.datafrozen.unknown",
												size: { value: 8192, resource: "memory" },
												zone_count: 2,
											},
										],
									},
								},
							},
						},
					},
				],
			},
		};
		const handlers = {
			...defaultHandlers,
			[`/api/v1/deployments/${DEPLOYMENT_ID}`]: () => currentWithUnrated,
			[`/api/v1/deployments/templates/${TARGET_TEMPLATE}`]: () => targetWithFrozen,
		};
		const handler = makeHandler({ ...baseCfg, defaultOrgId: ORG_ID }, makeFetch(handlers, []));
		const result = parseResult(
			await handler({ deployment_id: DEPLOYMENT_ID, target_template_id: TARGET_TEMPLATE, region: REGION }),
		);

		// Full total is null (frozen tier sized but unrated).
		expect(result.cost_estimate.current_monthly_ecu).toBeNull();
		expect(result.cost_estimate.current_monthly_ecu_complete).toBe(false);
		// SIO-825: priced-tiers subtotal is the hot tier's contribution; topology IDs spell out
		// which tiers were included so the subtotal can't be misread as the full target cost.
		expect(result.cost_estimate.current_monthly_ecu_priced_tiers_subtotal).toBeGreaterThan(0);
		expect(result.cost_estimate.current_monthly_ecu_priced_tiers_subtotal).toBeCloseTo(
			16 * 3 * HOT_RATE_PER_GB_RAM_HOUR * HOURS_PER_MONTH,
			1,
		);
		expect(result.cost_estimate.current_monthly_ecu_priced_tier_topology_ids).toEqual(["hot_content"]);
		// Target is also partial — same shape.
		expect(result.cost_estimate.target_monthly_ecu).toBeNull();
		expect(result.cost_estimate.target_monthly_ecu_complete).toBe(false);
		expect(result.cost_estimate.target_monthly_ecu_priced_tiers_subtotal).toBeGreaterThan(0);
		expect(result.cost_estimate.target_monthly_ecu_priced_tier_topology_ids).toEqual(["hot_content"]);
	});

	// ----- SIO-824 D2: billing_status surfaces 403 / no_match / network errors -----

	test("SIO-824 D2: wrong org_id (403) surfaces in diagnostics.billing_status", async () => {
		const wrongOrg = "9999999999";
		const handlers = {
			...defaultHandlers,
			[`/api/v2/billing/organizations/${wrongOrg}/costs/instances`]: () => ({
				status: 403,
				body: { error: "Forbidden" },
			}),
		};
		const handler = makeHandler({ ...baseCfg, defaultOrgId: ORG_ID }, makeFetch(handlers, []));
		const result = parseResult(
			await handler({
				deployment_id: DEPLOYMENT_ID,
				target_template_id: TARGET_TEMPLATE,
				region: REGION,
				org_id: wrongOrg,
			}),
		);
		expect(result.cost_estimate.diagnostics.billing_status).toBe("error:403");
		// No rates -> rate_source is "unavailable" (no env-var fallback configured).
		expect(result.cost_estimate.rate_source).toBe("unavailable");
		expect(result.cost_estimate.current_monthly_ecu).toBeNull();
	});

	test("SIO-824 D2: matching org_id with no row for this resource surfaces 'no_match'", async () => {
		const handlers = {
			...defaultHandlers,
			[`/api/v2/billing/organizations/${ORG_ID}/costs/instances`]: () => ({
				total_ecu: 100,
				instances: [{ id: "some-other-resource", product_line_items: [] }],
			}),
		};
		const handler = makeHandler({ ...baseCfg, defaultOrgId: ORG_ID }, makeFetch(handlers, []));
		const result = parseResult(
			await handler({ deployment_id: DEPLOYMENT_ID, target_template_id: TARGET_TEMPLATE, region: REGION }),
		);
		expect(result.cost_estimate.diagnostics.billing_status).toBe("no_match");
	});

	test("SIO-824 D2: happy-path billing call sets billing_status='ok'", async () => {
		const handler = makeHandler({ ...baseCfg, defaultOrgId: ORG_ID }, makeFetch(defaultHandlers, []));
		const result = parseResult(
			await handler({ deployment_id: DEPLOYMENT_ID, target_template_id: TARGET_TEMPLATE, region: REGION }),
		);
		expect(result.cost_estimate.diagnostics.billing_status).toBe("ok");
	});

	// ----- SIO-824 D3: region echo reflects deployment truth -----

	test("SIO-824 D3: deployment-region mismatch labels true region, surfaces warning, echoes user region", async () => {
		const handler = makeHandler({ ...baseCfg, defaultOrgId: ORG_ID }, makeFetch(defaultHandlers, []));
		// Deployment lives in aws-eu-central-1; caller asks aws-us-east-2.
		const result = parseResult(
			await handler({
				deployment_id: DEPLOYMENT_ID,
				target_template_id: TARGET_TEMPLATE,
				region: "aws-us-east-2",
			}),
		);
		expect(result.region).toBe(REGION); // deployment truth
		expect(result.target_template_region).toBe("aws-us-east-2"); // user input
		expect(result.warnings.length).toBe(1);
		expect(result.warnings[0]).toContain("does not match deployment region");
	});

	test("SIO-824 D3: matching region produces no warning", async () => {
		const handler = makeHandler({ ...baseCfg, defaultOrgId: ORG_ID }, makeFetch(defaultHandlers, []));
		const result = parseResult(
			await handler({ deployment_id: DEPLOYMENT_ID, target_template_id: TARGET_TEMPLATE, region: REGION }),
		);
		expect(result.region).toBe(REGION);
		expect(result.target_template_region).toBe(REGION);
		expect(result.warnings.length).toBe(0);
	});

	// ----- SIO-824 D4: unknown deployment_id surfaces a human-readable error -----

	test("SIO-824 D4: 403 on deployment fetch rephrases as 'not found or not accessible'", async () => {
		const handlers = {
			...defaultHandlers,
			[`/api/v1/deployments/${DEPLOYMENT_ID}`]: () => ({
				status: 403,
				body: { error: "Forbidden" },
			}),
		};
		const handler = makeHandler({ ...baseCfg, defaultOrgId: ORG_ID }, makeFetch(handlers, []));
		try {
			await handler({ deployment_id: DEPLOYMENT_ID, target_template_id: TARGET_TEMPLATE, region: REGION });
			throw new Error("expected handler to throw");
		} catch (err) {
			expect(err).toBeInstanceOf(McpError);
			const mcp = err as McpError;
			expect(mcp.message).toContain("not found or not accessible");
			expect(mcp.message).toContain(DEPLOYMENT_ID);
		}
	});

	test("SIO-824 D4: 404 on deployment fetch rephrases as 'not found or not accessible'", async () => {
		const handlers = {
			...defaultHandlers,
			[`/api/v1/deployments/${DEPLOYMENT_ID}`]: () => null, // 404
		};
		const handler = makeHandler({ ...baseCfg, defaultOrgId: ORG_ID }, makeFetch(handlers, []));
		try {
			await handler({ deployment_id: DEPLOYMENT_ID, target_template_id: TARGET_TEMPLATE, region: REGION });
			throw new Error("expected handler to throw");
		} catch (err) {
			expect(err).toBeInstanceOf(McpError);
			const mcp = err as McpError;
			expect(mcp.message).toContain("not found or not accessible");
		}
	});

	// ----- SIO-824 D5: Zod rejects bare cloud region -----

	test("SIO-824 D5: bare 'eu-central-1' (no aws-/gcp-/azure- prefix) is rejected by Zod", async () => {
		const handler = makeHandler({ ...baseCfg, defaultOrgId: ORG_ID }, makeFetch(defaultHandlers, []));
		try {
			await handler({ deployment_id: DEPLOYMENT_ID, target_template_id: TARGET_TEMPLATE, region: "eu-central-1" });
			throw new Error("expected handler to throw");
		} catch (err) {
			expect(err).toBeInstanceOf(McpError);
			const mcp = err as McpError;
			expect(mcp.message).toContain("Validation failed");
			const issues = (mcp.data as { issues?: Array<{ message?: string; path?: string[] }> } | undefined)?.issues ?? [];
			const regionIssue = issues.find((i) => i.path?.includes("region"));
			expect(regionIssue?.message).toContain("aws-");
		}
	});

	test("SIO-824 D5: gcp- prefixed region passes validation", async () => {
		const gcpRegion = "gcp-europe-west1";
		const handlers = {
			...defaultHandlers,
			[`/api/v1/deployments/${DEPLOYMENT_ID}`]: () => ({
				...deploymentFixture,
				resources: {
					elasticsearch: [{ ...deploymentFixture.resources.elasticsearch[0], region: gcpRegion }],
				},
			}),
		};
		const handler = makeHandler({ ...baseCfg, defaultOrgId: ORG_ID }, makeFetch(handlers, []));
		// Should not throw the Zod refinement error (may still fail later for other reasons).
		await expect(
			handler({ deployment_id: DEPLOYMENT_ID, target_template_id: TARGET_TEMPLATE, region: gcpRegion }),
		).resolves.toBeDefined();
	});

	// ----- SIO-825: cross-profile target ICs borrow rates from sibling deployments -----

	// Mirrors the ticket reproducer: a target profile introduces ICs the deployment has
	// never run (e.g. aws.es.datahot.m6gd when migrating from i3-based storage-optimized).
	// Without the sibling-borrow path, target_monthly_ecu and delta_monthly_ecu come back
	// null and the simulator is unusable for cross-profile migrations.
	const TARGET_ARM = "aws-general-purpose-arm";
	const HOT_ARM_IC = "aws.es.datahot.m6gd"; // target-only IC — absent from this deployment's billing
	const MASTER_ARM_IC = "aws.es.master.c6gd"; // target-only IC — absent from this deployment's billing
	const HOT_ARM_HOURLY = 2.4; // sibling-deployment rate (sized 16 GB × 3 = 48 GB-RAM-zones)
	const MASTER_ARM_HOURLY = 0.9; // sibling-deployment rate (sized 4 GB × 3 = 12 GB-RAM-zones)
	const HOT_ARM_RATE_PER_GB_RAM_HOUR = HOT_ARM_HOURLY / (16 * 3);
	const MASTER_ARM_RATE_PER_GB_RAM_HOUR = MASTER_ARM_HOURLY / (4 * 3);

	const armTargetTemplateFixture = {
		id: TARGET_ARM,
		name: "General Purpose ARM",
		deployment_template: {
			resources: {
				elasticsearch: [
					{
						plan: {
							cluster_topology: [
								{
									id: "hot_content",
									instance_configuration_id: HOT_ARM_IC,
									size: { value: 8192, resource: "memory" },
									zone_count: 2,
								},
								{
									id: "master",
									instance_configuration_id: MASTER_ARM_IC,
									size: { value: 1024, resource: "memory" },
									zone_count: 3,
								},
							],
						},
					},
				],
			},
		},
	};

	// Billing fixture with two rows: the simulated deployment (our existing ES_RESOURCE_ID
	// with i3-based ICs) AND a sibling deployment in the same region running m6gd ICs.
	// The sibling rates are what the target-tier resolution must fall back to.
	const SIBLING_RESOURCE_ID = "es-resource-sibling-arm";
	const billingInstancesWithSiblingFixture = {
		total_ecu: 22000,
		instances: [
			...billingInstancesFixture.instances,
			{
				id: SIBLING_RESOURCE_ID,
				name: "arm-deployment",
				type: "deployment",
				total_ecu: 9876,
				product_line_items: [
					{
						name: "Cloud Enterprise, AWS eu-central-1, aws.es.datahot.m6gd, 16GB, 3AZ",
						sku: `Cloud-Enterprise_${HOT_ARM_IC}_${REGION}_16384_3`,
						type: "capacity",
						unit: "hour",
						quantity: { value: 720, formatted_value: "720 hours" },
						rate: { value: HOT_ARM_HOURLY, formatted_value: `${HOT_ARM_HOURLY} per hour` },
						kind: "elasticsearch",
						total_ecu: HOT_ARM_HOURLY * 720,
					},
					{
						name: "Cloud Enterprise, AWS eu-central-1, aws.es.master.c6gd, 4GB, 3AZ",
						sku: `Cloud-Enterprise_${MASTER_ARM_IC}_${REGION}_4096_3`,
						type: "capacity",
						unit: "hour",
						quantity: { value: 720, formatted_value: "720 hours" },
						rate: { value: MASTER_ARM_HOURLY, formatted_value: `${MASTER_ARM_HOURLY} per hour` },
						kind: "elasticsearch",
						total_ecu: MASTER_ARM_HOURLY * 720,
					},
				],
			},
		],
	};

	test("SIO-825: cross-profile simulate prices target ICs from sibling deployments — delta is non-null", async () => {
		const handlers = {
			...defaultHandlers,
			[`/api/v1/deployments/templates/${TARGET_ARM}`]: () => armTargetTemplateFixture,
			[`/api/v2/billing/organizations/${ORG_ID}/costs/instances`]: () => billingInstancesWithSiblingFixture,
		};
		const handler = makeHandler({ ...baseCfg, defaultOrgId: ORG_ID }, makeFetch(handlers, []));
		const result = parseResult(
			await handler({ deployment_id: DEPLOYMENT_ID, target_template_id: TARGET_ARM, region: REGION }),
		);

		// Reproducer assertion: target total + delta are now non-null (used to be null).
		expect(result.cost_estimate.target_monthly_ecu).not.toBeNull();
		expect(result.cost_estimate.delta_monthly_ecu).not.toBeNull();
		expect(result.cost_estimate.target_monthly_ecu_complete).toBe(true);

		// Hot tier in target topology uses the sibling deployment's rate, not the current i3 rate.
		const targetHot = result.target_profile.elasticsearch_topology.find(
			(t) => t.instance_configuration_id === HOT_ARM_IC,
		);
		expect(targetHot?.rate_per_gb_ram_hour).toBeCloseTo(HOT_ARM_RATE_PER_GB_RAM_HOUR, 6);
		expect(targetHot?.rate_source).toContain("org-wide");
		expect(targetHot?.rate_source).toContain("sibling deployments");

		// Master tier likewise picks up the sibling's c6gd rate.
		const targetMaster = result.target_profile.elasticsearch_topology.find(
			(t) => t.instance_configuration_id === MASTER_ARM_IC,
		);
		expect(targetMaster?.rate_per_gb_ram_hour).toBeCloseTo(MASTER_ARM_RATE_PER_GB_RAM_HOUR, 6);
		expect(targetMaster?.rate_source).toContain("org-wide");
	});

	test("SIO-825: per-tier rate_source distinguishes deployment-billed vs sibling-borrowed", async () => {
		const handlers = {
			...defaultHandlers,
			[`/api/v1/deployments/templates/${TARGET_ARM}`]: () => armTargetTemplateFixture,
			[`/api/v2/billing/organizations/${ORG_ID}/costs/instances`]: () => billingInstancesWithSiblingFixture,
		};
		const handler = makeHandler({ ...baseCfg, defaultOrgId: ORG_ID }, makeFetch(handlers, []));
		const result = parseResult(
			await handler({ deployment_id: DEPLOYMENT_ID, target_template_id: TARGET_ARM, region: REGION }),
		);

		// Current topology still uses this deployment's own billed rates.
		const currentHot = result.current_profile.elasticsearch_topology.find(
			(t) => t.instance_configuration_id === HOT_IC,
		);
		expect(currentHot?.rate_source).toContain("billing API: per-IC rate");
		expect(currentHot?.rate_source).not.toContain("org-wide");

		// Target hot uses the sibling rate and is labelled distinctly.
		const targetHot = result.target_profile.elasticsearch_topology.find(
			(t) => t.instance_configuration_id === HOT_ARM_IC,
		);
		expect(targetHot?.rate_source).toContain("org-wide per-IC rate");
		expect(targetHot?.rate_source).toContain(REGION);

		// Headline rate_source reflects the mixed sourcing.
		expect(result.cost_estimate.rate_source).toContain("sibling-deployment");
	});

	test("SIO-825: sibling rates from a different region MUST NOT contribute (rate isolation)", async () => {
		// Sibling deployment is in aws-us-east-1 but our simulated deployment is in
		// aws-eu-central-1. Cross-region borrow would silently mis-price by a wide margin.
		const otherRegion = "aws-us-east-1";
		const crossRegionSiblingFixture = {
			total_ecu: 22000,
			instances: [
				...billingInstancesFixture.instances,
				{
					id: SIBLING_RESOURCE_ID,
					name: "arm-deployment-us",
					type: "deployment",
					total_ecu: 9876,
					product_line_items: [
						{
							name: "Cloud Enterprise, AWS us-east-1, aws.es.datahot.m6gd, 16GB, 3AZ",
							sku: `Cloud-Enterprise_${HOT_ARM_IC}_${otherRegion}_16384_3`,
							type: "capacity",
							unit: "hour",
							quantity: { value: 720, formatted_value: "720 hours" },
							rate: { value: HOT_ARM_HOURLY, formatted_value: `${HOT_ARM_HOURLY} per hour` },
							kind: "elasticsearch",
							total_ecu: HOT_ARM_HOURLY * 720,
						},
					],
				},
			],
		};
		const handlers = {
			...defaultHandlers,
			[`/api/v1/deployments/templates/${TARGET_ARM}`]: () => armTargetTemplateFixture,
			[`/api/v2/billing/organizations/${ORG_ID}/costs/instances`]: () => crossRegionSiblingFixture,
		};
		const handler = makeHandler({ ...baseCfg, defaultOrgId: ORG_ID }, makeFetch(handlers, []));
		const result = parseResult(
			await handler({ deployment_id: DEPLOYMENT_ID, target_template_id: TARGET_ARM, region: REGION }),
		);

		// The target hot tier finds no rate from any source — sibling is in another region,
		// no env-var fallback configured, no entry in this deployment's billing.
		const targetHot = result.target_profile.elasticsearch_topology.find(
			(t) => t.instance_configuration_id === HOT_ARM_IC,
		);
		expect(targetHot?.rate_per_gb_ram_hour).toBeNull();
		expect(targetHot?.rate_source).toBe("unavailable");
		expect(result.cost_estimate.unmatched_target_ics).toContain(HOT_ARM_IC);
		// Without the env-var fallback the full target total is null — partial still surfaces.
		expect(result.cost_estimate.target_monthly_ecu).toBeNull();
		expect(result.cost_estimate.target_monthly_ecu_complete).toBe(false);
	});

	test("SIO-825: when this deployment's billing has the rate, sibling map is not consulted (no rate_source drift)", async () => {
		// Sibling row exists with a wildly different rate for an IC that our deployment
		// ALREADY runs. We must keep using the deployment's own rate, not the sibling's.
		const conflictingSiblingFixture = {
			total_ecu: 22000,
			instances: [
				...billingInstancesFixture.instances,
				{
					id: SIBLING_RESOURCE_ID,
					name: "sibling-cheap",
					type: "deployment",
					total_ecu: 1234,
					product_line_items: [
						{
							name: "sibling priced HOT_IC much cheaper",
							sku: `Cloud-Enterprise_${HOT_IC}_${REGION}_16384_3`,
							type: "capacity",
							unit: "hour",
							quantity: { value: 720, formatted_value: "720 hours" },
							rate: { value: HOT_HOURLY / 10, formatted_value: "decoy" },
							kind: "elasticsearch",
							total_ecu: (HOT_HOURLY / 10) * 720,
						},
					],
				},
			],
		};
		const handlers = {
			...defaultHandlers,
			[`/api/v2/billing/organizations/${ORG_ID}/costs/instances`]: () => conflictingSiblingFixture,
		};
		const handler = makeHandler({ ...baseCfg, defaultOrgId: ORG_ID }, makeFetch(handlers, []));
		const result = parseResult(
			await handler({ deployment_id: DEPLOYMENT_ID, target_template_id: TARGET_TEMPLATE, region: REGION }),
		);
		const hot = result.current_profile.elasticsearch_topology.find((t) => t.instance_configuration_id === HOT_IC);
		// Deployment's own rate wins — not the sibling's decoy.
		expect(hot?.rate_per_gb_ram_hour).toBeCloseTo(HOT_RATE_PER_GB_RAM_HOUR, 6);
		expect(hot?.rate_source).toContain("billing API: per-IC rate");
		expect(hot?.rate_source).not.toContain("org-wide");
	});

	// ----- SIO-826: operator rate catalog (EC_RATE_CATALOG_PATH) -----

	// Catalog test fixtures: written to tmpdir per-test to mirror real operator setup.
	const ORPHAN_HOT_IC = "aws.es.datahot.m6gd"; // not in this deployment, not in any sibling
	const ORPHAN_HOT_RATE = 0.0594; // operator-supplied catalog rate

	const armTargetTemplateOrphanHot = {
		id: TARGET_ARM,
		name: "General Purpose ARM",
		deployment_template: {
			resources: {
				elasticsearch: [
					{
						plan: {
							cluster_topology: [
								{
									id: "hot_content",
									instance_configuration_id: ORPHAN_HOT_IC,
									size: { value: 8192, resource: "memory" },
									zone_count: 2,
								},
							],
						},
					},
				],
			},
		},
	};

	function writeCatalogFile(payload: unknown): string {
		const tmp = `${tmpdir()}/sio826-catalog-${Math.random().toString(36).slice(2)}.json`;
		writeFileSync(tmp, typeof payload === "string" ? payload : JSON.stringify(payload), "utf8");
		return tmp;
	}

	test("SIO-826: catalog hit prices an IC that no deployment in the org runs (delta non-null)", async () => {
		const catalogPath = writeCatalogFile({
			$schema: "EC_RATE_CATALOG v1",
			refreshed: "2026-05-22",
			rates: { [REGION]: { [ORPHAN_HOT_IC]: ORPHAN_HOT_RATE } },
		});
		const handlers = {
			...defaultHandlers,
			[`/api/v1/deployments/templates/${TARGET_ARM}`]: () => armTargetTemplateOrphanHot,
		};
		const handler = makeHandler(
			{ ...baseCfg, defaultOrgId: ORG_ID, rateCatalogPath: catalogPath },
			makeFetch(handlers, []),
		);
		const result = parseResult(
			await handler({ deployment_id: DEPLOYMENT_ID, target_template_id: TARGET_ARM, region: REGION }),
		);

		// Reproducer assertion: the orphan IC now has a rate, so the headline numbers exist.
		expect(result.cost_estimate.target_monthly_ecu).not.toBeNull();
		expect(result.cost_estimate.delta_monthly_ecu).not.toBeNull();
		expect(result.cost_estimate.target_monthly_ecu_complete).toBe(true);
		expect(result.cost_estimate.unmatched_target_ics).toEqual([]);

		// Hot tier is priced from the catalog with the expected provenance label.
		const targetHot = result.target_profile.elasticsearch_topology.find(
			(t) => t.instance_configuration_id === ORPHAN_HOT_IC,
		);
		expect(targetHot?.rate_per_gb_ram_hour).toBeCloseTo(ORPHAN_HOT_RATE, 6);
		expect(targetHot?.rate_source).toContain("list price (catalog");
		expect(targetHot?.rate_source).toContain("refreshed 2026-05-22");

		// Confidence rolls up to mixed because current uses billed-actual + target uses catalog.
		expect(result.cost_estimate.rate_source_confidence).toBe("mixed");

		unlinkSync(catalogPath);
	});

	test("SIO-826: catalog does NOT override billed-actual rates (deployment billing wins)", async () => {
		// Catalog has a decoy rate 100x off for an IC the deployment already runs.
		const catalogPath = writeCatalogFile({
			$schema: "EC_RATE_CATALOG v1",
			refreshed: "2026-05-22",
			rates: { [REGION]: { [HOT_IC]: HOT_RATE_PER_GB_RAM_HOUR * 100 } },
		});
		const handler = makeHandler(
			{ ...baseCfg, defaultOrgId: ORG_ID, rateCatalogPath: catalogPath },
			makeFetch(defaultHandlers, []),
		);
		const result = parseResult(
			await handler({ deployment_id: DEPLOYMENT_ID, target_template_id: TARGET_TEMPLATE, region: REGION }),
		);
		const hot = result.current_profile.elasticsearch_topology.find((t) => t.instance_configuration_id === HOT_IC);
		// Deployment's own billed rate wins; catalog decoy ignored.
		expect(hot?.rate_per_gb_ram_hour).toBeCloseTo(HOT_RATE_PER_GB_RAM_HOUR, 6);
		expect(hot?.rate_source).toContain("billing API: per-IC rate");
		expect(hot?.rate_source).not.toContain("catalog");
		// All tiers from this deployment's billing → confidence is billed_actual.
		expect(result.cost_estimate.rate_source_confidence).toBe("billed_actual");

		unlinkSync(catalogPath);
	});

	test("SIO-826: malformed catalog file degrades gracefully (no throw, no rates)", async () => {
		// Three flavours of broken: non-existent path, invalid JSON, wrong shape.
		const nonexistent = `${tmpdir()}/sio826-does-not-exist-${Math.random().toString(36).slice(2)}.json`;
		const invalidJson = writeCatalogFile("{ not json");
		const wrongShape = writeCatalogFile({ rates: "not an object" });

		for (const path of [nonexistent, invalidJson, wrongShape]) {
			const handler = makeHandler(
				{ ...baseCfg, defaultOrgId: ORG_ID, rateCatalogPath: path },
				makeFetch(defaultHandlers, []),
			);
			// Constructor + handler invocation must not throw — server stays up.
			const result = parseResult(
				await handler({ deployment_id: DEPLOYMENT_ID, target_template_id: TARGET_TEMPLATE, region: REGION }),
			);
			// Catalog ignored → tool behaves as if EC_RATE_CATALOG_PATH was unset.
			expect(result.cost_estimate.current_monthly_ecu).not.toBeNull();
			expect(result.cost_estimate.rate_source_confidence).toBe("billed_actual");
			for (const tier of result.current_profile.elasticsearch_topology) {
				expect(tier.rate_source).not.toContain("catalog");
			}
		}

		unlinkSync(invalidJson);
		unlinkSync(wrongShape);
	});

	test("SIO-826: confidence flag matrix — billed_actual / mixed / fallback_only", async () => {
		// (a) all-billing-happy-path → billed_actual.
		const handlerBilled = makeHandler({ ...baseCfg, defaultOrgId: ORG_ID }, makeFetch(defaultHandlers, []));
		const resultBilled = parseResult(
			await handlerBilled({ deployment_id: DEPLOYMENT_ID, target_template_id: TARGET_TEMPLATE, region: REGION }),
		);
		expect(resultBilled.cost_estimate.rate_source_confidence).toBe("billed_actual");

		// (b) catalog covers one tier, billing covers the rest → mixed.
		const catalogPath = writeCatalogFile({
			$schema: "EC_RATE_CATALOG v1",
			refreshed: "2026-05-22",
			rates: { [REGION]: { [ORPHAN_HOT_IC]: ORPHAN_HOT_RATE } },
		});
		const mixedHandlers = {
			...defaultHandlers,
			[`/api/v1/deployments/templates/${TARGET_ARM}`]: () => armTargetTemplateOrphanHot,
		};
		const handlerMixed = makeHandler(
			{ ...baseCfg, defaultOrgId: ORG_ID, rateCatalogPath: catalogPath },
			makeFetch(mixedHandlers, []),
		);
		const resultMixed = parseResult(
			await handlerMixed({ deployment_id: DEPLOYMENT_ID, target_template_id: TARGET_ARM, region: REGION }),
		);
		expect(resultMixed.cost_estimate.rate_source_confidence).toBe("mixed");

		// (c) no billing source at all (no org_id) but env-var scalar prices every tier → fallback_only.
		const handlerEnvOnly = makeHandler(
			{ ...baseCfg, pricePerGbRamHour: 0.05 }, // no defaultOrgId
			makeFetch(defaultHandlers, []),
		);
		const resultEnvOnly = parseResult(
			await handlerEnvOnly({ deployment_id: DEPLOYMENT_ID, target_template_id: TARGET_TEMPLATE, region: REGION }),
		);
		expect(resultEnvOnly.cost_estimate.rate_source_confidence).toBe("fallback_only");

		unlinkSync(catalogPath);
	});
});

// Live test: skipped unless ELASTIC_CLOUD_LIVE_TESTS=1 and EC_API_KEY / EC_DEFAULT_ORG_ID
// are set. Exercises the tool against a real Elastic Cloud org and validates that the
// SIO-822 / SIO-823 fixes work end-to-end against the production billing surface.
const LIVE =
	process.env.ELASTIC_CLOUD_LIVE_TESTS === "1" && !!process.env.EC_API_KEY && !!process.env.EC_DEFAULT_ORG_ID;

describe.skipIf(!LIVE)("elasticsearch_cloud_simulate_hardware_profile_change (live)", () => {
	const LIVE_DEPLOYMENT = process.env.ELASTIC_CLOUD_LIVE_DEPLOYMENT ?? "02655c3733ea471999d9cec39a17df32";
	const LIVE_REGION = process.env.ELASTIC_CLOUD_LIVE_REGION ?? "aws-eu-central-1";
	const LIVE_TARGET = process.env.ELASTIC_CLOUD_LIVE_TARGET_TEMPLATE ?? "aws-cpu-optimized";

	test("produces non-null per-IC cost estimate against real billing", async () => {
		const cfg: ElasticCloudConfig = {
			apiKey: process.env.EC_API_KEY ?? "",
			endpoint: "https://api.elastic-cloud.com",
			requestTimeout: 30000,
			maxRetries: 1,
			defaultOrgId: process.env.EC_DEFAULT_ORG_ID,
		};
		const server = new McpServer({ name: "live-t", version: "1.0.0" });
		registerCloudSimulateHardwareProfileChangeTool(server, new CloudClient(cfg));
		const tool = getToolFromServer(server, "elasticsearch_cloud_simulate_hardware_profile_change");
		if (!tool) throw new Error("tool not registered");
		const handler = tool.handler as (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;

		const result = parseResult(
			await handler({ deployment_id: LIVE_DEPLOYMENT, target_template_id: LIVE_TARGET, region: LIVE_REGION }),
		);

		expect(typeof result.cost_estimate.rate_per_gb_ram_hour).toBe("number");
		expect((result.cost_estimate.rate_per_gb_ram_hour ?? 0) > 0).toBe(true);
		expect(result.cost_estimate.rate_source.startsWith("billing API")).toBe(true);
		const matched = result.current_profile.elasticsearch_topology.filter((t) =>
			t.rate_source.startsWith("billing API"),
		);
		expect(matched.length).toBeGreaterThan(0);
		for (const t of matched) expect((t.rate_per_gb_ram_hour ?? 0) > 0).toBe(true);
		const headline = result.cost_estimate.rate_per_gb_ram_hour ?? 0;
		const distinct = matched.some((t) => Math.abs((t.rate_per_gb_ram_hour ?? 0) - headline) > 1e-6);
		expect(distinct).toBe(true);
		for (const t of result.target_profile.elasticsearch_topology) {
			expect(t.size_gb_ram).toBeGreaterThan(0);
		}
	}, 60_000);
});

// tests/unit/tools/cloud/simulate_hardware_profile_change.test.ts

import { describe, expect, test } from "bun:test";
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

function makeFetch(handlers: Record<string, (u: URL) => unknown | null>, log: CallLog[]): FetchLike {
	return async (u) => {
		const url = new URL(String(u));
		log.push({ url: String(u), pathname: url.pathname });
		// Order longest prefix first so /costs/instances/<id>/items matches before /costs/instances
		const sortedPrefixes = Object.keys(handlers).sort((a, b) => b.length - a.length);
		for (const prefix of sortedPrefixes) {
			if (url.pathname.startsWith(prefix)) {
				const body = handlers[prefix]?.(url);
				if (body === null) return new Response("", { status: 404 });
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
	current_profile: { elasticsearch_topology: Tier[]; total_gb_ram_zones: number };
	target_profile: { elasticsearch_topology: Tier[]; total_gb_ram_zones: number; topology_warnings: string[] };
	cost_estimate: {
		rate_per_gb_ram_hour: number | null;
		rate_source: string;
		current_monthly_ecu: number | null;
		target_monthly_ecu: number | null;
		delta_monthly_ecu: number | null;
		unmatched_tier_ics: string[];
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
		// The deployment ID must NEVER appear in a billing URL path segment
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
		// Headline rate is the GB-RAM-zone-weighted average across current topology
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
		// No tier should price at the APM or Kibana rate
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
		expect(hot?.size_gb_ram).toBe(16); // current actual, NOT 8 (template default)
		expect(hot?.zone_count).toBe(3); // current actual, NOT 2 (template default)
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
		// Target carries the same sizes as current (projection), so target ECU equals current ECU.
		expect(result.cost_estimate.target_monthly_ecu).toBe(result.cost_estimate.current_monthly_ecu);
		expect(result.cost_estimate.delta_monthly_ecu).toBe(0);
	});

	test("env-var fallback prices tiers whose IC is absent from billing", async () => {
		// Drop the cold tier from billing so its IC has no per-IC rate.
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
		expect(result.cost_estimate.unmatched_tier_ics).toContain(COLD_IC);
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
		// Per-tier rate fields are still null but tiers exist
		expect(result.current_profile.elasticsearch_topology.length).toBe(3);
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
	});

	test("same_profile short-circuit: target equals current when template ids match", async () => {
		const handler = makeHandler({ ...baseCfg, defaultOrgId: ORG_ID }, makeFetch(defaultHandlers, []));
		const result = parseResult(
			await handler({ deployment_id: DEPLOYMENT_ID, target_template_id: CURRENT_TEMPLATE, region: REGION }),
		);
		expect(result.compatibility.same_profile).toBe(true);
		// Current template has empty cluster_topology, so every current tier is unmatched -> warnings for all 3
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
		// Live observation: deployment topology uses `aws.es.master.c5d` while billing
		// SKU is `aws.es.master.c5d.2`. The matcher must normalise both forms.
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
});

// Live test: skipped unless ELASTIC_CLOUD_LIVE_TESTS=1 and EC_API_KEY / EC_DEFAULT_ORG_ID
// are set. Exercises the tool against a real Elastic Cloud org and validates that the
// SIO-822 / SIO-823 fixes work end-to-end against the production billing surface.
const LIVE =
	process.env.ELASTIC_CLOUD_LIVE_TESTS === "1" && !!process.env.EC_API_KEY && !!process.env.EC_DEFAULT_ORG_ID;

describe.skipIf(!LIVE)("elasticsearch_cloud_simulate_hardware_profile_change (live)", () => {
	// eu-b2b deployment in org 2461430096; aws-eu-central-1; aws-cpu-optimized as the target.
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
		// Every tier with billing match should have a positive rate
		const matched = result.current_profile.elasticsearch_topology.filter((t) =>
			t.rate_source.startsWith("billing API"),
		);
		expect(matched.length).toBeGreaterThan(0);
		for (const t of matched) expect((t.rate_per_gb_ram_hour ?? 0) > 0).toBe(true);
		// Per-IC pricing engaged: at least one tier's rate differs from headline rate
		const headline = result.cost_estimate.rate_per_gb_ram_hour ?? 0;
		const distinct = matched.some((t) => Math.abs((t.rate_per_gb_ram_hour ?? 0) - headline) > 1e-6);
		expect(distinct).toBe(true);
		// Target projection populated for matched tiers
		for (const t of result.target_profile.elasticsearch_topology) {
			expect(t.size_gb_ram).toBeGreaterThan(0);
		}
	}, 60_000);
});

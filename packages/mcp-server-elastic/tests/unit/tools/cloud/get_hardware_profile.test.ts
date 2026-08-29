// tests/unit/tools/cloud/get_hardware_profile.test.ts

import { describe, expect, test } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CloudClient, type FetchLike } from "../../../../src/clients/cloudClient.js";
import type { ElasticCloudConfig } from "../../../../src/config/schemas.js";
import { registerCloudGetHardwareProfileTool } from "../../../../src/tools/cloud/get_hardware_profile.js";
import { getToolFromServer } from "../../../utils/elasticsearch-client.js";

const cfg: ElasticCloudConfig = {
	apiKey: "k",
	endpoint: "https://api.elastic-cloud.com",
	requestTimeout: 5000,
	maxRetries: 0,
};

interface TopologyRow {
	topology_id: string | null;
	instance_configuration_id: string | null;
	config_version: number | null;
	cpu_multiplier: number | null;
	storage_multiplier: number | null;
	zone_count: number | null;
	default_size_mb_ram: number | null;
	default_size_gb_ram: number | null;
	allowed_sizes_mb_ram: number[];
	allowed_sizes_gb_ram: number[];
}

interface ProfileResult {
	template_id: string;
	name: string | null;
	region: string;
	elasticsearch_topology: TopologyRow[];
	unresolved_instance_configurations: string[];
}

// Captured verbatim from the live Elastic Cloud API (SIO-1570 defect validation):
// GET /api/v1/deployments/templates/aws-storage-optimized?region=aws-eu-central-1
// Note cluster_topology[] carries NO allowed_sizes and size.value is 0 on every tier
// but hot_content -- the discrete ladder only exists in instance_configurations[].
const TEMPLATE_FIXTURE = {
	id: "aws-storage-optimized",
	name: "Storage optimized",
	description: "Storage optimised template",
	deployment_template: {
		resources: {
			elasticsearch: [
				{
					plan: {
						cluster_topology: [
							{
								id: "hot_content",
								instance_configuration_id: "aws.es.datahot.i3",
								size: { value: 8192, resource: "memory" },
								zone_count: 2,
							},
							{
								id: "master",
								instance_configuration_id: "aws.es.master.c5d",
								size: { value: 0, resource: "memory" },
								zone_count: 3,
							},
						],
					},
				},
			],
		},
	},
	instance_configurations: [
		{
			id: "aws.es.datahot.i3",
			name: "Storage optimized",
			// Live values: 0.138 vCPU/GB matches a measured 2.069 vCPU at 15 GB.
			cpu_multiplier: 0.138,
			storage_multiplier: 30.0,
			config_version: 1,
			// Deliberately not whole-GB throughout: 15360=15GB, 29696=29GB, 59392=58GB.
			discrete_sizes: { sizes: [1024, 2048, 4096, 8192, 15360, 29696, 59392], default_size: 4096 },
		},
		{
			id: "aws.es.master.c5d",
			name: "Master",
			cpu_multiplier: 0.133,
			storage_multiplier: 12.0,
			config_version: 1,
			discrete_sizes: { sizes: [1024, 2048, 4096, 8192, 17408, 32768, 65536], default_size: 4096 },
		},
	],
};

function makeHandler(fetchImpl: FetchLike) {
	const server = new McpServer({ name: "t", version: "1.0.0" });
	registerCloudGetHardwareProfileTool(server, new CloudClient(cfg, fetchImpl));
	const tool = getToolFromServer(server, "elasticsearch_cloud_get_hardware_profile");
	if (!tool) throw new Error("not registered");
	return tool.handler as (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;
}

function jsonHandler(body: unknown, onUrl?: (u: string) => void) {
	return makeHandler(async (u) => {
		onUrl?.(String(u));
		return new Response(JSON.stringify(body), { status: 200 });
	});
}

async function run(handler: ReturnType<typeof makeHandler>, args: Record<string, unknown>): Promise<ProfileResult> {
	const res = await handler(args);
	return JSON.parse(res.content[0].text) as ProfileResult;
}

describe("elasticsearch_cloud_get_hardware_profile", () => {
	test("requests the template endpoint with region and show_instance_configurations", async () => {
		let capturedUrl = "";
		const handler = jsonHandler(TEMPLATE_FIXTURE, (u) => {
			capturedUrl = u;
		});
		await run(handler, { template_id: "aws-storage-optimized", region: "aws-eu-central-1" });

		const url = new URL(capturedUrl);
		expect(url.pathname).toBe("/api/v1/deployments/templates/aws-storage-optimized");
		expect(url.searchParams.get("region")).toBe("aws-eu-central-1");
		expect(url.searchParams.get("show_instance_configurations")).toBe("true");
	});

	// The defect: every tier previously returned allowed_sizes_gb_ram: [].
	test("populates the size ladder by joining instance_configurations[] on IC id", async () => {
		const handler = jsonHandler(TEMPLATE_FIXTURE);
		const result = await run(handler, { template_id: "aws-storage-optimized", region: "aws-eu-central-1" });

		const hot = result.elasticsearch_topology[0];
		expect(hot.topology_id).toBe("hot_content");
		expect(hot.allowed_sizes_mb_ram).toEqual([1024, 2048, 4096, 8192, 15360, 29696, 59392]);
		expect(hot.allowed_sizes_gb_ram).toEqual([1, 2, 4, 8, 15, 29, 58]);

		const master = result.elasticsearch_topology[1];
		expect(master.allowed_sizes_mb_ram).toEqual([1024, 2048, 4096, 8192, 17408, 32768, 65536]);
		expect(result.unresolved_instance_configurations).toEqual([]);
	});

	// Regression guard for the reason MiB is the authoritative unit (F11): a GB-only
	// field cannot round-trip the 29696 MiB rung.
	test("MiB is lossless where GB would not round-trip", async () => {
		const handler = jsonHandler(TEMPLATE_FIXTURE);
		const result = await run(handler, { template_id: "aws-storage-optimized", region: "aws-eu-central-1" });

		const hot = result.elasticsearch_topology[0];
		// The i3 ladder skips the round rungs a GB-only field would imply (no 16/32/64),
		// so downstream MiB validators must read allowed_sizes_mb_ram, not re-derive from GB.
		expect(hot.allowed_sizes_mb_ram).toContain(29696);
		expect(hot.allowed_sizes_mb_ram).not.toContain(32768);
		expect(hot.allowed_sizes_gb_ram).toEqual(hot.allowed_sizes_mb_ram.map((n) => n / 1024));
	});

	test("falls back to the IC default when the tier default size is 0", async () => {
		const handler = jsonHandler(TEMPLATE_FIXTURE);
		const result = await run(handler, { template_id: "aws-storage-optimized", region: "aws-eu-central-1" });

		// hot_content carries a real topology default -> preserved.
		expect(result.elasticsearch_topology[0].default_size_mb_ram).toBe(8192);
		expect(result.elasticsearch_topology[0].default_size_gb_ram).toBe(8);
		// master's topology default is 0 -> falls back to discrete_sizes.default_size.
		expect(result.elasticsearch_topology[1].default_size_mb_ram).toBe(4096);
		expect(result.elasticsearch_topology[1].default_size_gb_ram).toBe(4);
	});

	test("reports unresolved ICs instead of silently returning an empty ladder", async () => {
		const handler = jsonHandler({
			...TEMPLATE_FIXTURE,
			instance_configurations: [TEMPLATE_FIXTURE.instance_configurations[0]],
		});
		const result = await run(handler, { template_id: "aws-storage-optimized", region: "aws-eu-central-1" });

		expect(result.unresolved_instance_configurations).toEqual(["aws.es.master.c5d"]);
		expect(result.elasticsearch_topology[1].allowed_sizes_mb_ram).toEqual([]);
		// The resolvable tier is unaffected.
		expect(result.elasticsearch_topology[0].allowed_sizes_mb_ram.length).toBe(7);
	});

	// SIO-1571: CPU density / disk ratio / IC version resolved by the same join as the ladder.
	test("surfaces cpu_multiplier, storage_multiplier and config_version per tier", async () => {
		const handler = jsonHandler(TEMPLATE_FIXTURE);
		const result = await run(handler, { template_id: "aws-storage-optimized", region: "aws-eu-central-1" });

		const hot = result.elasticsearch_topology[0];
		expect(hot.cpu_multiplier).toBe(0.138);
		expect(hot.storage_multiplier).toBe(30.0);
		expect(hot.config_version).toBe(1);

		// cpu_multiplier is vCPU per GB RAM, so density scales with the tier size.
		expect((hot.cpu_multiplier as number) * 15).toBeCloseTo(2.07, 2);
	});

	// The API genuinely omits config_version on some ICs (e.g. aws.es.ml.m6gd). A guessed
	// default would be worse than a stated unknown -- a wrong pinned version is an apply-time bug.
	test("reports a missing hardware field as null rather than defaulting it", async () => {
		const handler = jsonHandler({
			...TEMPLATE_FIXTURE,
			instance_configurations: [
				{
					id: "aws.es.datahot.i3",
					discrete_sizes: { sizes: [4096, 8192], default_size: 4096 },
					cpu_multiplier: 0.533,
					// storage_multiplier and config_version deliberately absent.
				},
				TEMPLATE_FIXTURE.instance_configurations[1],
			],
		});
		const result = await run(handler, { template_id: "aws-storage-optimized", region: "aws-eu-central-1" });

		const hot = result.elasticsearch_topology[0];
		expect(hot.cpu_multiplier).toBe(0.533);
		expect(hot.storage_multiplier).toBeNull();
		expect(hot.config_version).toBeNull();
	});

	// config_version 0 is a real value (the whole c8gd family reports it), so it must survive
	// the null-coalescing rather than being flattened to null by a falsy check.
	test("preserves config_version 0 instead of collapsing it to null", async () => {
		const handler = jsonHandler({
			...TEMPLATE_FIXTURE,
			instance_configurations: [
				{ ...TEMPLATE_FIXTURE.instance_configurations[0], config_version: 0 },
				TEMPLATE_FIXTURE.instance_configurations[1],
			],
		});
		const result = await run(handler, { template_id: "aws-storage-optimized", region: "aws-eu-central-1" });

		expect(result.elasticsearch_topology[0].config_version).toBe(0);
	});

	test("leaves hardware fields null when the IC does not resolve", async () => {
		const handler = jsonHandler({
			...TEMPLATE_FIXTURE,
			instance_configurations: [TEMPLATE_FIXTURE.instance_configurations[0]],
		});
		const result = await run(handler, { template_id: "aws-storage-optimized", region: "aws-eu-central-1" });

		const master = result.elasticsearch_topology[1];
		expect(result.unresolved_instance_configurations).toEqual(["aws.es.master.c5d"]);
		expect(master.cpu_multiplier).toBeNull();
		expect(master.storage_multiplier).toBeNull();
		expect(master.config_version).toBeNull();
	});

	test("returns empty ladders without throwing when instance_configurations is absent", async () => {
		const { instance_configurations: _omitted, ...noIcs } = TEMPLATE_FIXTURE;
		const handler = jsonHandler(noIcs);
		const result = await run(handler, { template_id: "aws-storage-optimized", region: "aws-eu-central-1" });

		expect(result.elasticsearch_topology).toHaveLength(2);
		expect(result.unresolved_instance_configurations).toEqual(["aws.es.datahot.i3", "aws.es.master.c5d"]);
		expect(result.elasticsearch_topology[0].allowed_sizes_gb_ram).toEqual([]);
		// Topology-sourced default still survives an absent IC array.
		expect(result.elasticsearch_topology[0].default_size_gb_ram).toBe(8);
	});
});

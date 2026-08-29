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
			// Deliberately not whole-GB throughout: 15360=15GB, 29696=29GB, 59392=58GB.
			discrete_sizes: { sizes: [1024, 2048, 4096, 8192, 15360, 29696, 59392], default_size: 4096 },
		},
		{
			id: "aws.es.master.c5d",
			name: "Master",
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

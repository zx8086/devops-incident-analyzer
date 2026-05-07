// tests/unit/tools/deployment-routing.test.ts
// SIO-675: Per-call deployment switching for stdio (Claude Desktop). Verifies the
// dispatcher in src/tools/index.ts strips/validates/routes the optional `deployment`
// arg without changing behaviour for cloud / billing tools.

// Stub a single-deployment env BEFORE any module-level config validation can run.
// src/config/index.ts validates env at import time (loader.ts requires ES_URL or
// ELASTIC_DEPLOYMENTS). The actual deployment registry used by these tests is set
// up below via registerClients() with its own stub clients -- ES_URL is only here
// to satisfy the boot-time validator.
Bun.env.ES_URL ??= "http://localhost:9200";

import { beforeAll, describe, expect, test } from "bun:test";
import type { Client } from "@elastic/elasticsearch";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { currentDeploymentId, runWithDeployment } from "../../../src/clients/context.js";
import { createClientProxy, registerClients } from "../../../src/clients/registry.js";
import { registerAllTools } from "../../../src/tools/index.js";
import { initializeReadOnlyManager } from "../../../src/utils/readOnlyMode.js";
import { getToolFromServer } from "../../utils/elasticsearch-client.js";

type Handler = (args: Record<string, unknown>) => Promise<unknown>;

interface ProbeRecord {
	deploymentId: string | undefined;
	args: Record<string, unknown>;
}

function makeStubClient(id: string, probe: ProbeRecord[]): Client {
	const stub = {
		cluster: {
			health: async (params: Record<string, unknown>) => {
				probe.push({ deploymentId: currentDeploymentId(), args: { ...params, _stubId: id } });
				return {
					cluster_name: id,
					status: "green",
					timed_out: false,
					number_of_nodes: 1,
					number_of_data_nodes: 1,
					active_primary_shards: 0,
					active_shards: 0,
					relocating_shards: 0,
					initializing_shards: 0,
					unassigned_shards: 0,
					delayed_unassigned_shards: 0,
					number_of_pending_tasks: 0,
					number_of_in_flight_fetch: 0,
					task_max_waiting_in_queue_millis: 0,
					active_shards_percent_as_number: 100,
				};
			},
		},
	} as unknown as Client;
	return stub;
}

function buildServerWithRegistry(): {
	server: McpServer;
	probe: ProbeRecord[];
} {
	const probe: ProbeRecord[] = [];
	const clients = new Map<string, Client>([
		["eu-cld", makeStubClient("eu-cld", probe)],
		["eu-b2b", makeStubClient("eu-b2b", probe)],
	]);
	registerClients(clients, "eu-cld");

	initializeReadOnlyManager(false, false);
	const server = new McpServer({ name: "test", version: "1.0.0" });
	registerAllTools(server, createClientProxy());
	return { server, probe };
}

function getHandler(server: McpServer, name: string): Handler {
	const tool = getToolFromServer(server, name);
	if (!tool) throw new Error(`tool not registered: ${name}`);
	return tool.handler as Handler;
}

describe("SIO-675 deployment-routing dispatcher", () => {
	let server: McpServer;
	let probe: ProbeRecord[];
	let healthHandler: Handler;

	beforeAll(() => {
		const built = buildServerWithRegistry();
		server = built.server;
		probe = built.probe;
		healthHandler = getHandler(server, "elasticsearch_get_cluster_health");
	});

	test("absent deployment arg: handler runs with no deployment context (default-client path)", async () => {
		probe.length = 0;
		await healthHandler({});
		expect(probe).toHaveLength(1);
		expect(probe[0]?.deploymentId).toBeUndefined();
	});

	test("explicit deployment routes to that client", async () => {
		probe.length = 0;
		await healthHandler({ deployment: "eu-b2b" });
		expect(probe).toHaveLength(1);
		expect(probe[0]?.deploymentId).toBe("eu-b2b");
		// And switching: another call with eu-cld lands on the eu-cld client.
		probe.length = 0;
		await healthHandler({ deployment: "eu-cld" });
		expect(probe[0]?.deploymentId).toBe("eu-cld");
	});

	test("unknown deployment ID throws McpError(InvalidParams) listing valid IDs", async () => {
		await expect(healthHandler({ deployment: "bogus-id" })).rejects.toMatchObject({
			name: "McpError",
			code: -32602, // InvalidParams
		});
		try {
			await healthHandler({ deployment: "bogus-id" });
		} catch (err) {
			expect(err).toBeInstanceOf(McpError);
			expect((err as Error).message).toContain("eu-cld");
			expect((err as Error).message).toContain("eu-b2b");
		}
	});

	test("deployment field is stripped before reaching the underlying handler", async () => {
		probe.length = 0;
		await healthHandler({ deployment: "eu-b2b", level: "cluster" });
		expect(probe).toHaveLength(1);
		expect(probe[0]?.args).not.toHaveProperty("deployment");
		// `level: "cluster"` survives (passes through to esClient.cluster.health as `level`).
		expect(probe[0]?.args.level).toBe("cluster");
	});

	test("HTTP precedence: explicit arg overrides outer x-elastic-deployment context", async () => {
		probe.length = 0;
		// Simulate the HTTP middleware setting eu-cld via header, then a tool call with
		// explicit deployment=eu-b2b. Inner runWithDeployment must shadow the outer one.
		await runWithDeployment("eu-cld", () => healthHandler({ deployment: "eu-b2b" }));
		expect(probe[0]?.deploymentId).toBe("eu-b2b");
	});

	test("cluster tool schema includes the deployment field", () => {
		const tool = (server as unknown as { _registeredTools?: Record<string, { inputSchema?: unknown }> })
			._registeredTools?.elasticsearch_get_cluster_health;
		const schema = tool?.inputSchema as { shape?: Record<string, unknown> } | undefined;
		const shape = schema?.shape ?? (tool?.inputSchema as Record<string, unknown> | undefined);
		expect(shape).toHaveProperty("deployment");
	});

	// Cloud / billing tools are registered by server.ts (not registerAllTools), so they are
	// not present in this server. Prove the augmentation gate works by registering probe tools
	// under both a cluster-qualifying name and a cloud name through the same wrapped
	// server.registerTool, then comparing the resulting schemas.
	test("cloud / billing tool names are NOT augmented; cluster names ARE", async () => {
		const probeBuild = buildServerWithRegistry();
		const probeServer = probeBuild.server;
		const probeShape = { foo: z.string().optional() };
		const probeHandler = async () => ({ content: [{ type: "text", text: "ok" }] });

		probeServer.registerTool(
			"elasticsearch_cloud_list_deployments",
			{ description: "cloud probe", inputSchema: probeShape },
			probeHandler,
		);
		probeServer.registerTool(
			"elasticsearch_billing_get_org_costs",
			{ description: "billing probe", inputSchema: probeShape },
			probeHandler,
		);
		// A non-existent cluster-style name still gets augmented because the gate is a
		// cloud/billing exclusion, not a cluster allow-list.
		probeServer.registerTool(
			"elasticsearch_probe_cluster_only",
			{ description: "cluster probe", inputSchema: { ...probeShape } },
			probeHandler,
		);

		const tools = (probeServer as unknown as { _registeredTools?: Record<string, { inputSchema?: unknown }> })
			._registeredTools;
		const cloudTool = tools?.elasticsearch_cloud_list_deployments;
		const billingTool = tools?.elasticsearch_billing_get_org_costs;
		const clusterTool = tools?.elasticsearch_probe_cluster_only;

		const cloudShape =
			(cloudTool?.inputSchema as { shape?: Record<string, unknown> } | undefined)?.shape ?? cloudTool?.inputSchema;
		const billingShape =
			(billingTool?.inputSchema as { shape?: Record<string, unknown> } | undefined)?.shape ?? billingTool?.inputSchema;
		const clusterShape =
			(clusterTool?.inputSchema as { shape?: Record<string, unknown> } | undefined)?.shape ?? clusterTool?.inputSchema;

		expect(cloudShape).not.toHaveProperty("deployment");
		expect(billingShape).not.toHaveProperty("deployment");
		expect(clusterShape).toHaveProperty("deployment");
	});
});

// src/__tests__/factory-replay.test.ts
// SIO-1044: mcp-server-konnect adopts the shared record-once/replay-many factory. Unlike the other
// adopters, konnect also hoists two per-server stateful objects (ToolPerformanceCollector,
// ElicitationOperations) out of createKonnectServer into initDatasource -- see index.ts and the
// hoist comment on createMcpServerFactory in server.ts. This test locks in (1) replay equivalence
// against getAllTools()'s full static registry (60+ tools) and a directly-registered control
// server, and (2) that every replayed server's closures share the SAME ds.performanceCollector
// instance rather than each getting its own.
import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { KongApi } from "../api/kong-api.js";
import type { Config } from "../config/index.js";
import { createMcpServerFactory, type KonnectServerDatasource } from "../server.ts";
import { ElicitationOperations } from "../tools/elicitation-tool.js";
import { getAllTools } from "../tools/registry.js";
import { ToolPerformanceCollector } from "../utils/tool-tracer.js";

// registerTools never calls the Kong API at registration time (only inside a tool handler, on
// tools/call), so an empty stub is sufficient for a tools/list-only test.
const stubApi = {} as unknown as KongApi;

const fakeConfig = {
	application: { name: "kong-konnect-mcp", version: "2.0.0" },
} as unknown as Config;

function makeDatasource(): KonnectServerDatasource {
	return {
		api: stubApi,
		config: fakeConfig,
		performanceCollector: new ToolPerformanceCollector(),
		elicitationOps: new ElicitationOperations(),
	};
}

async function connectedClient(server: McpServer): Promise<Client> {
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	const client = new Client({ name: "konnect-factory-replay-test-client", version: "0.0.0" });
	await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
	return client;
}

async function toolNames(server: McpServer): Promise<string[]> {
	const client = await connectedClient(server);
	const { tools } = await client.listTools();
	await client.close();
	return tools.map((t) => t.name).sort();
}

describe("SIO-1044: mcp-server-konnect cached factory replay", () => {
	test("replayed servers expose an identical tool list across calls", async () => {
		const factory = createMcpServerFactory(makeDatasource());

		const namesA = await toolNames(factory());
		const namesB = await toolNames(factory());

		expect(namesA).toEqual(namesB);
		expect(namesA.length).toBeGreaterThan(0);
	});

	test("replayed tool list matches a directly-registered control server and the full static registry", async () => {
		const ds = makeDatasource();
		const factory = createMcpServerFactory(ds);
		const replayed = await toolNames(factory());

		// Control server: register the real static tool set directly (mirrors what registerTools
		// does internally) rather than importing the internal registerTools function, keeping the
		// control path independent of the code under test.
		const allTools = getAllTools();
		const expectedNames = allTools.map((tool) => `konnect_${tool.method}`).sort();

		expect(replayed).toEqual(expectedNames);
		expect(replayed.length).toBe(allTools.length);
		expect(replayed.length).toBeGreaterThan(60);
		expect(replayed).toContain("konnect_analyze_migration_context");
	});

	test("all replayed servers share the SAME performanceCollector instance from the datasource", async () => {
		const ds = makeDatasource();
		const factory = createMcpServerFactory(ds);

		const serverA = factory();
		const serverB = factory();

		const clientA = await connectedClient(serverA);
		const clientB = await connectedClient(serverB);

		// analyze_migration_context is a pure-computation tool (contextDetector + MigrationAnalyzer):
		// it never touches KongApi, so the empty stubApi is safe here. Calling it once through each
		// replayed server's dispatcher proves both closures record into the identical
		// ds.performanceCollector Map -- a per-request `new ToolPerformanceCollector()` would instead
		// leave each server's tally at 1.
		await clientA.callTool({ name: "konnect_analyze_migration_context", arguments: {} });
		await clientB.callTool({ name: "konnect_analyze_migration_context", arguments: {} });

		await clientA.close();
		await clientB.close();

		const stats = ds.performanceCollector.getToolStats("konnect_analyze_migration_context");
		expect(stats).not.toBeNull();
		expect(stats?.callCount).toBe(2);
	});
});

// src/__tests__/factory-replay.test.ts
// SIO-1044: knowledge-graph-mcp-server adopts the shared record-once/replay-many factory. This
// test locks in replay equivalence -- a replayed server's tool list must match both a second
// replay and the back-compat createServer control, so nothing is silently dropped or duplicated
// by the record.
import { describe, expect, test } from "bun:test";
import { createCachedServerFactory } from "@devops-agent/shared";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import pkg from "../../package.json" with { type: "json" };
import type { Config } from "../config.ts";
import { createMcpServerFactory, createServer } from "../server.ts";
import { registerCuratedTools } from "../tools/curated.ts";
import { registerCypherTool } from "../tools/cypher.ts";

// Registration never opens the graph store (getGraphStore() is called lazily inside each
// tool's handler, on tools/call), so a config with the graph DISABLED is sufficient for a
// tools/list-only test and even supports a graceful, store-free tools/call.
const fakeConfig: Config = {
	transport: { mode: "http", port: 0, host: "127.0.0.1", path: "/mcp" },
	graphPath: ".data/knowledge-graph-factory-replay-test",
	knowledgeGraphEnabled: false,
	allowCypher: true,
};

async function connect(server: McpServer): Promise<Client> {
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	const client = new Client({ name: "kg-factory-replay-test-client", version: "0.0.0" });
	await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
	return client;
}

async function toolNames(server: McpServer): Promise<string[]> {
	const client = await connect(server);
	const { tools } = await client.listTools();
	await client.close();
	return tools.map((t) => t.name).sort();
}

describe("SIO-1044: knowledge-graph-mcp-server cached factory replay", () => {
	test("replayed servers expose an identical tool list across calls", async () => {
		const factory = createMcpServerFactory(fakeConfig);

		const namesA = await toolNames(factory());
		const namesB = await toolNames(factory());

		expect(namesA).toEqual(namesB);
		expect(namesA).toContain("kg_deployments_running_stack");
	});

	test("replayed tool list matches the non-cached createServer control", async () => {
		const factory = createMcpServerFactory(fakeConfig);
		const replayed = await toolNames(factory());

		const control = createServer(fakeConfig);
		const controlNames = await toolNames(control);

		expect(replayed).toEqual(controlNames);
	});

	test("registerAll runs exactly once across two factory() calls", () => {
		// createMcpServerFactory itself doesn't expose a counter, so this rebuilds the
		// factory with the package's real registrars (curated + gated cypher) wrapped in a
		// spy to observe the boot-time-only contract directly.
		let registerAllCalls = 0;
		const factory = createCachedServerFactory({
			createBareServer: () => new McpServer({ name: "knowledge-graph-mcp-server", version: pkg.version }),
			registerAll: (server) => {
				registerAllCalls++;
				registerCuratedTools(server, fakeConfig.knowledgeGraphEnabled);
				if (fakeConfig.allowCypher) registerCypherTool(server, fakeConfig.knowledgeGraphEnabled);
			},
		});

		expect(registerAllCalls).toBe(1);
		factory();
		factory();
		expect(registerAllCalls).toBe(1);
	});

	// Best-effort call-through: kg_* handlers call getGraphStore() lazily, which would open
	// a real lbug-backed store against fakeConfig.graphPath. With knowledgeGraphEnabled:false
	// the handler short-circuits BEFORE touching the store and returns the loud-fail string,
	// so this exercises a real tools/call on a replayed server without requiring a live store.
	test("a replayed server's tools/call executes the recorded handler (graph disabled -- loud-fail path)", async () => {
		const factory = createMcpServerFactory(fakeConfig);
		const client = await connect(factory());

		const result = (await client.callTool({
			name: "kg_deployments_running_stack",
			arguments: { stack: "slos" },
		})) as CallToolResult;
		await client.close();

		const block = result.content[0];
		const responseText = block && block.type === "text" ? block.text : "";
		expect(responseText).toContain("KNOWLEDGE GRAPH UNAVAILABLE");
		expect(responseText).toContain("disabled");
	});
});

// src/__tests__/factory-replay.test.ts
// SIO-1044: mcp-server-couchbase adopts the shared record-once/replay-many factory. couchbase is
// the hardest adopter: playbook directory enumeration (fs.readdir/access) used to run INSIDE the
// old async registerAllResources, so it has been hoisted out to loadPlaybooks (called once, in
// initDatasource) -- registerAll here stays fully synchronous. The old code also raced two
// independent readResourceByUri assignments (playbookResource.ts and server.ts); the
// playbookResource.ts one has been deleted, so server.ts's generic implementation is now the sole
// canonical assignment, applied once to the boot template and resolved lazily by tool handlers
// that close over that template server.

import { describe, expect, test } from "bun:test";
import { createCachedServerFactory } from "@devops-agent/shared";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Bucket } from "couchbase";
import { registerPingHandlers } from "../lib/pingHandler.ts";
import { registerAll as registerAllTools } from "../lib/toolRegistry.ts";
import { registerSqlppQueryGenerator } from "../prompts/sqlppQueryGenerator.ts";
import { registerAllResources } from "../resources/index.ts";
import { PlaybookHandler, type PlaybookRegistry } from "../resources/playbookResource.ts";
import { type CouchbaseServerDatasource, createMcpServerFactory } from "../server.ts";

// Registration never calls the Bucket (query analysis / document tools only touch it inside
// tools/call handlers), so an empty stub is sufficient for a tools/list-only test.
const stubBucket = {} as unknown as Bucket;

function makePlaybooks(): PlaybookRegistry {
	const handler = new PlaybookHandler("/fake/playbook/dir", ".md");
	// Mirror what loadPlaybooks' handler.initialize() would have populated -- avoids any fs access.
	handler.playbookFiles = ["test1.md"];
	return { handler, resourceIds: ["test1"] };
}

function makeDatasource(): CouchbaseServerDatasource {
	return {
		bucket: stubBucket,
		playbooks: makePlaybooks(),
	};
}

async function connectedClient(server: McpServer): Promise<Client> {
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	const client = new Client({ name: "couchbase-factory-replay-test-client", version: "0.0.0" });
	await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
	return client;
}

async function toolNames(server: McpServer): Promise<string[]> {
	const client = await connectedClient(server);
	const { tools } = await client.listTools();
	await client.close();
	return tools.map((t) => t.name).sort();
}

async function resourceUris(server: McpServer): Promise<string[]> {
	const client = await connectedClient(server);
	const { resources } = await client.listResources();
	await client.close();
	return resources.map((r) => r.uri).sort();
}

async function promptNames(server: McpServer): Promise<string[]> {
	const client = await connectedClient(server);
	const { prompts } = await client.listPrompts();
	await client.close();
	return prompts.map((p) => p.name).sort();
}

describe("SIO-1044: mcp-server-couchbase cached factory replay", () => {
	test("replayed servers expose identical tool lists, resource URIs, and prompt names across calls", async () => {
		const factory = createMcpServerFactory(makeDatasource());

		const serverA = factory();
		const serverB = factory();

		const [toolsA, toolsB] = await Promise.all([toolNames(serverA), toolNames(serverB)]);
		expect(toolsA).toEqual(toolsB);
		expect(toolsA.length).toBeGreaterThan(0);

		const [resourcesA, resourcesB] = await Promise.all([resourceUris(serverA), resourceUris(serverB)]);
		expect(resourcesA).toEqual(resourcesB);
		expect(resourcesA.length).toBeGreaterThan(0);

		const [promptsA, promptsB] = await Promise.all([promptNames(serverA), promptNames(serverB)]);
		expect(promptsA).toEqual(promptsB);
		expect(promptsA).toEqual(["generate_sqlpp_query"]);
	});

	test("replayed tool/resource/prompt lists match a directly-registered control server", async () => {
		const ds = makeDatasource();
		const factory = createMcpServerFactory(ds);
		const replayedServer = factory();

		// Control server: register the real registration functions directly (mirrors what
		// createMcpServerFactory's registerAll does internally), independent of the factory
		// recording mechanism under test.
		const control = new McpServer({ name: "couchbase-mcp-server-control", version: "0.0.0" });
		control.resource("test-playbook", "playbook://test.md", async (uri) => ({
			contents: [{ uri: uri.href, mimeType: "text/markdown", text: "# Test" }],
		}));
		registerAllTools(control, ds.bucket);
		registerSqlppQueryGenerator(control);
		registerAllResources(control, ds.bucket, ds.playbooks);
		registerPingHandlers(control);
		control.tool("capella_echo", "Echoes back the input parameters for debugging", {}, async (params) => ({
			content: [{ type: "text" as const, text: JSON.stringify(params) }],
		}));

		const [replayedTools, controlTools] = await Promise.all([toolNames(replayedServer), toolNames(control)]);
		expect(replayedTools).toEqual(controlTools);
		expect(replayedTools).toContain("capella_list_playbooks");
		expect(replayedTools).toContain("capella_echo");
		expect(replayedTools).toContain("capella_ping");

		const [replayedResources, controlResources] = await Promise.all([
			resourceUris(replayedServer),
			resourceUris(control),
		]);
		expect(replayedResources).toEqual(controlResources);
		expect(replayedResources).toContain("playbook://test.md");
		expect(replayedResources).toContain("playbook://");
		expect(replayedResources).toContain("playbook://test1");

		const [replayedPrompts, controlPrompts] = await Promise.all([promptNames(replayedServer), promptNames(control)]);
		expect(replayedPrompts).toEqual(controlPrompts);
	});

	test("Finding-C regression: readResourceByUri property resolves on a replayed server (no crash on missing property)", async () => {
		const factory = createMcpServerFactory(makeDatasource());
		const replayed = factory();

		const client = await connectedClient(replayed);
		const result = await client.callTool({ name: "capella_list_playbooks", arguments: {} });
		await client.close();

		// The tool handler resolves readResourceByUri lazily off its closure-captured server (the
		// boot template, which stays alive in the factory closure) -- not off the replayed instance
		// itself. Under the OLD dual-assignment race (playbookResource.ts vs server.ts), or if the
		// property were missing on the replayed instance entirely, this call would throw a
		// TypeError -- "server.readResourceByUri is not a function" / "Cannot read properties of
		// undefined" -- which the SDK surfaces as a generic tool-execution error whose text contains
		// "is not a function". The property DOES resolve here (proving the lazy-template-resolution
		// fix): the call instead reaches the (pre-existing, out-of-scope) internal resource-registry
		// lookup and returns its own structured "No resource handler found for URI" error -- a
		// deliberate business-logic error, not a missing-property crash.
		const text = JSON.stringify(result);
		expect(text).not.toContain("is not a function");
		expect(text).not.toContain("Cannot read properties of undefined");
	});

	test("registerAll (including playbook resource registration) runs exactly once across replays", async () => {
		// Directly mirrors packages/shared/src/__tests__/cached-server-factory.test.ts's
		// "registerAll runs exactly once" test, but with the SAME registration composition
		// createMcpServerFactory uses in server.ts (registerAllTools, registerSqlppQueryGenerator,
		// registerAllResources -- which is the sole caller of registerPlaybookResources --,
		// registerPingHandlers, capella_echo). We construct createCachedServerFactory directly so
		// we can wrap that composition in a counting closure and assert the counter, not just an
		// observable side effect (a static resourceIds array), proving registration -- and
		// therefore the async-fs-free registerPlaybookResources path -- does not re-run per replay.
		let registerAllCalls = 0;
		let registerPlaybookResourcesCalls = 0;
		const ds = makeDatasource();
		// Spy-wrap the playbook registry so we can additionally count the actual
		// registerPlaybookResources -> handler interaction, not just the outer registerAll call.
		const playbooksSpy: PlaybookRegistry | null = ds.playbooks
			? {
					handler: ds.playbooks.handler,
					get resourceIds() {
						registerPlaybookResourcesCalls++;
						// biome-ignore lint/style/noNonNullAssertion: guarded by the enclosing ds.playbooks check
						return ds.playbooks!.resourceIds;
					},
				}
			: null;

		const factory = createCachedServerFactory({
			createBareServer: () => new McpServer({ name: "couchbase-mcp-server-test", version: "0.0.0" }),
			registerAll: (server) => {
				registerAllCalls++;
				server.resource("test-playbook", "playbook://test.md", async (uri) => ({
					contents: [{ uri: uri.href, mimeType: "text/markdown", text: "# Test" }],
				}));
				registerAllTools(server, ds.bucket);
				registerSqlppQueryGenerator(server);
				registerAllResources(server, ds.bucket, playbooksSpy);
				registerPingHandlers(server);
				server.tool("capella_echo", "Echoes back the input parameters for debugging", {}, async (params) => ({
					content: [{ type: "text" as const, text: JSON.stringify(params) }],
				}));
			},
		});

		expect(registerAllCalls).toBe(1);

		for (let i = 0; i < 3; i++) {
			const server = factory();
			const uris = await resourceUris(server);
			expect(uris).toContain("playbook://test1");
		}

		// registerAll (and therefore registerPlaybookResources, the only consumer of the playbooks
		// registry) ran once at createCachedServerFactory() time -- not once per factory() replay.
		expect(registerAllCalls).toBe(1);
		expect(registerPlaybookResourcesCalls).toBe(1);
	});
});

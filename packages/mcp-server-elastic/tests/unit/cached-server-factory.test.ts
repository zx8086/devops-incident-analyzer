// tests/unit/cached-server-factory.test.ts
// SIO-1041: the record/replay factory must interoperate with elastic's OWN registerTool
// monkey-patch (tools/index.ts adds tracing + security + deployment-routing wrappers). The
// recorder binds itself as that patch's delegate, so the recorded triples are the FINAL wrapped
// versions -- two replays must expose an identical tool surface without re-running registerAllTools.
import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../../src/config/index.js";
import { createMcpServerFactory } from "../../src/server.js";
import { registerAllTools } from "../../src/tools/index.js";

// The ES client is never called during registration (only inside handlers), so a shim suffices.
const fakeClient = {} as Parameters<typeof registerAllTools>[1];

const fakeConfig = {
	server: { name: "elastic-test", version: "0.0.0", readOnlyMode: false },
} as unknown as Config;

async function listToolNames(server: McpServer): Promise<string[]> {
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	const client = new Client({ name: "t", version: "0.0.0" });
	await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
	const { tools } = await client.listTools();
	await client.close();
	return tools.map((t) => t.name).sort();
}

describe("SIO-1041: elastic createMcpServerFactory record/replay", () => {
	test("two replayed servers expose an identical, non-empty tool list", async () => {
		const factory = createMcpServerFactory(fakeConfig, fakeClient, null);
		const a = await listToolNames(factory());
		const b = await listToolNames(factory());
		expect(a.length).toBeGreaterThan(50);
		expect(b).toEqual(a);
	});

	test("a replayed server's tool list matches a one-off registerAllTools instance (no tools dropped)", async () => {
		const factory = createMcpServerFactory(fakeConfig, fakeClient, null);
		const replayed = await listToolNames(factory());

		// Baseline: the exact set registerAllTools reports when called directly.
		const { McpServer: McpServerCtor } = await import("@modelcontextprotocol/sdk/server/mcp.js");
		const oneOff = new McpServerCtor({ name: "elastic-test", version: "0.0.0" });
		const expected = registerAllTools(oneOff, fakeClient)
			.map((t) => t.name)
			.sort();

		expect(replayed).toEqual(expected);
	});
});

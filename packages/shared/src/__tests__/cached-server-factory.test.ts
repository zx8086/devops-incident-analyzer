// shared/src/__tests__/cached-server-factory.test.ts
// SIO-1041: record-once / replay-many factory must produce identical tool surfaces per request
// without re-running the (expensive) registerAll on every request.
import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createCachedServerFactory } from "../cached-server-factory.ts";

function bareServer(): McpServer {
	return new McpServer(
		{ name: "cache-test", version: "0.0.0" },
		{ capabilities: { tools: { listChanged: true } } as Record<string, unknown> },
	);
}

async function connectedClient(server: McpServer): Promise<Client> {
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	const client = new Client({ name: "test-client", version: "0.0.0" });
	await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
	return client;
}

async function toolNames(server: McpServer): Promise<string[]> {
	const client = await connectedClient(server);
	const { tools } = await client.listTools();
	await client.close();
	return tools.map((t) => t.name).sort();
}

describe("createCachedServerFactory", () => {
	test("registerAll runs exactly once at factory creation, never per replay", () => {
		let runs = 0;
		const factory = createCachedServerFactory({
			createBareServer: bareServer,
			registerAll: (server) => {
				runs++;
				server.registerTool("a", { description: "a", inputSchema: z.object({}).shape }, async () => ({
					content: [{ type: "text", text: "a" }],
				}));
			},
		});
		expect(runs).toBe(1);
		factory();
		factory();
		expect(runs).toBe(1);
	});

	test("record once / replay twice -> both servers expose identical tools/list", async () => {
		const factory = createCachedServerFactory({
			createBareServer: bareServer,
			registerAll: (server) => {
				server.registerTool("alpha", { description: "alpha", inputSchema: z.object({}).shape }, async () => ({
					content: [{ type: "text", text: "alpha" }],
				}));
				server.registerTool("beta", { description: "beta", inputSchema: z.object({}).shape }, async () => ({
					content: [{ type: "text", text: "beta" }],
				}));
			},
		});

		const namesA = await toolNames(factory());
		const namesB = await toolNames(factory());
		expect(namesA).toEqual(["alpha", "beta"]);
		expect(namesB).toEqual(namesA);
	});

	test("a tools/call on a replayed server executes the recorded handler", async () => {
		const factory = createCachedServerFactory({
			createBareServer: bareServer,
			registerAll: (server) => {
				server.registerTool(
					"echo",
					{ description: "echo", inputSchema: z.object({ msg: z.string() }).shape },
					async (args: { msg: string }) => ({ content: [{ type: "text", text: `echo:${args.msg}` }] }),
				);
			},
		});
		const client = await connectedClient(factory());
		const result = (await client.callTool({ name: "echo", arguments: { msg: "hi" } })) as {
			content: Array<{ type: string; text: string }>;
		};
		await client.close();
		expect(result.content[0]?.text).toBe("echo:hi");
	});

	// The recorder must sit UNDER any monkey-patch installed on the template by registerAll,
	// so the recorded triples are the FINAL wrapped versions. Mirrors elastic's tools/index.ts
	// which instance-patches registerTool to add tracing/security wrappers.
	test("monkey-patch ordering: a wrapper patched AFTER the recorder is captured verbatim", async () => {
		const marker: string[] = [];
		const factory = createCachedServerFactory({
			createBareServer: bareServer,
			registerAll: (server) => {
				// registerAll installs its OWN patch on top of the recorder (like elastic's tools/index.ts).
				type Registrar = (...args: unknown[]) => unknown;
				const original = (server.registerTool as Registrar).bind(server);
				(server as unknown as { registerTool: Registrar }).registerTool = (...args: unknown[]) => {
					const [name, config, handler] = args as [string, unknown, (a: unknown, e: unknown) => Promise<unknown>];
					const wrapped = async (a: unknown, e: unknown) => {
						marker.push(`wrapped:${name}`);
						return handler(a, e);
					};
					return original(name, config, wrapped);
				};

				server.registerTool("wrapped-tool", { description: "w", inputSchema: z.object({}).shape }, async () => ({
					content: [{ type: "text", text: "ran" }],
				}));
			},
		});

		// Two independent replays must both run the wrapper (proving the wrapped handler was recorded).
		const client1 = await connectedClient(factory());
		await client1.callTool({ name: "wrapped-tool", arguments: {} });
		await client1.close();
		const client2 = await connectedClient(factory());
		await client2.callTool({ name: "wrapped-tool", arguments: {} });
		await client2.close();
		expect(marker).toEqual(["wrapped:wrapped-tool", "wrapped:wrapped-tool"]);
	});

	test("records and replays registerPrompt and registerResource too", async () => {
		const factory = createCachedServerFactory({
			createBareServer: bareServer,
			registerAll: (server) => {
				server.registerPrompt("greet", { description: "greet" }, () => ({
					messages: [{ role: "user", content: { type: "text", text: "hello" } }],
				}));
				server.registerResource("cfg", "cfg://app", { description: "cfg" }, async () => ({
					contents: [{ uri: "cfg://app", text: "value" }],
				}));
			},
		});
		const client = await connectedClient(factory());
		const { prompts } = await client.listPrompts();
		const { resources } = await client.listResources();
		await client.close();
		expect(prompts.map((p) => p.name)).toContain("greet");
		expect(resources.map((r) => r.name)).toContain("cfg");
	});

	// SIO-1044/SIO-1050: legacy sugar methods (tool/resource/prompt) independently call the private
	// _createRegistered* methods in SDK 1.29.0 -- they do NOT delegate to register*. A recorder that
	// only patches registerTool/registerResource/registerPrompt silently drops any legacy-API
	// registration, so it exists only on the discarded boot template and is missing on every replay.
	test("legacy server.tool(...) registration is present and callable on replayed servers", async () => {
		const factory = createCachedServerFactory({
			createBareServer: bareServer,
			registerAll: (server) => {
				server.tool("legacy-echo", "legacy echo", { msg: z.string() }, async (args: { msg: string }) => ({
					content: [{ type: "text", text: `legacy:${args.msg}` }],
				}));
			},
		});

		const namesA = await toolNames(factory());
		expect(namesA).toContain("legacy-echo");

		const client = await connectedClient(factory());
		const result = (await client.callTool({ name: "legacy-echo", arguments: { msg: "hi" } })) as {
			content: Array<{ type: string; text: string }>;
		};
		await client.close();
		expect(result.content[0]?.text).toBe("legacy:hi");
	});

	test("legacy server.resource(...) and server.prompt(...) are recorded/replayed", async () => {
		const factory = createCachedServerFactory({
			createBareServer: bareServer,
			registerAll: (server) => {
				server.resource("legacy-cfg", "cfg://legacy", async () => ({
					contents: [{ uri: "cfg://legacy", text: "legacy-value" }],
				}));
				server.prompt("legacy-greet", "legacy greet", () => ({
					messages: [{ role: "user", content: { type: "text", text: "legacy hello" } }],
				}));
			},
		});
		const client = await connectedClient(factory());
		const { prompts } = await client.listPrompts();
		const { resources } = await client.listResources();
		await client.close();
		expect(prompts.map((p) => p.name)).toContain("legacy-greet");
		expect(resources.map((r) => r.name)).toContain("legacy-cfg");
	});

	test("interleaved tool()/registerTool() calls replay in original registration order", async () => {
		const factory = createCachedServerFactory({
			createBareServer: bareServer,
			registerAll: (server) => {
				server.tool("z-legacy", async () => ({ content: [{ type: "text", text: "z" }] }));
				server.registerTool("y-modern", { description: "y", inputSchema: z.object({}).shape }, async () => ({
					content: [{ type: "text", text: "y" }],
				}));
				server.tool("x-legacy", async () => ({ content: [{ type: "text", text: "x" }] }));
			},
		});

		// Control server: same registrations run directly, without going through the factory.
		const control = bareServer();
		control.tool("z-legacy", async () => ({ content: [{ type: "text", text: "z" }] }));
		control.registerTool("y-modern", { description: "y", inputSchema: z.object({}).shape }, async () => ({
			content: [{ type: "text", text: "y" }],
		}));
		control.tool("x-legacy", async () => ({ content: [{ type: "text", text: "x" }] }));

		async function unsortedToolNames(server: McpServer): Promise<string[]> {
			const client = await connectedClient(server);
			const { tools } = await client.listTools();
			await client.close();
			return tools.map((t) => t.name);
		}

		const replayedOrder = await unsortedToolNames(factory());
		const controlOrder = await unsortedToolNames(control);
		expect(replayedOrder).toEqual(controlOrder);
		expect(replayedOrder).toEqual(["z-legacy", "y-modern", "x-legacy"]);
	});

	// Mirrors the couchbase toolRegistry.ts pattern: a consumer wraps server.tool with its own
	// handler-tracing wrapper AFTER the recorder has already captured server.tool verbatim.
	test("consumer wrapper patched on server.tool after the recorder is captured verbatim", async () => {
		const marker: string[] = [];
		const factory = createCachedServerFactory({
			createBareServer: bareServer,
			registerAll: (server) => {
				type Registrar = (...args: unknown[]) => unknown;
				const original = (server.tool as Registrar).bind(server);
				(server as unknown as { tool: Registrar }).tool = (...args: unknown[]) => {
					const [name, ...rest] = args as [string, ...unknown[]];
					const handler = rest[rest.length - 1] as (a: unknown, e: unknown) => Promise<unknown>;
					const wrapped = async (a: unknown, e: unknown) => {
						marker.push(`wrapped:${name}`);
						return handler(a, e);
					};
					return original(name, ...rest.slice(0, -1), wrapped);
				};

				server.tool("wrapped-legacy-tool", async () => ({ content: [{ type: "text", text: "ran" }] }));
			},
		});

		const client1 = await connectedClient(factory());
		await client1.callTool({ name: "wrapped-legacy-tool", arguments: {} });
		await client1.close();
		const client2 = await connectedClient(factory());
		await client2.callTool({ name: "wrapped-legacy-tool", arguments: {} });
		await client2.close();
		expect(marker).toEqual(["wrapped:wrapped-legacy-tool", "wrapped:wrapped-legacy-tool"]);
	});
});

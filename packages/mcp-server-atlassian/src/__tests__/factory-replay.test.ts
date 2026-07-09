// src/__tests__/factory-replay.test.ts
// SIO-1044: atlassian-mcp-server adopts the shared record-once/replay-many factory. This is an
// upstream-proxy server -- discoveredTools is a boot-time snapshot (initDatasource discovers it
// once via discoverRemoteTools), so registerAll iterating that frozen array at boot is sound.
// This test locks in replay equivalence -- a replayed server's tool list must match both a
// second replay and a directly-registered control server built from the same stubs.
import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AtlassianMcpProxy, ProxyToolInfo } from "../atlassian-client/index.js";
import type { Config } from "../config/index.js";
import { type AtlassianDatasource, createMcpServerFactory } from "../server.js";
import { registerCustomTools } from "../tools/custom/index.js";
import { registerProxyTools } from "../tools/proxy/index.js";

// Registration never calls the proxy (handlers run only on tools/call), so a minimal stub is
// sufficient for a tools/list-only test. handlers are never invoked here.
const stubProxy = {
	callTool: async () => ({ content: [] }),
	listTools: async () => [],
} as unknown as AtlassianMcpProxy;

const fakeConfig = {
	application: { name: "atlassian-mcp-server", version: "0.0.0" },
	atlassian: { readOnly: true, incidentProjects: ["INC"] },
} as unknown as Config;

// Shaped like the real discovery output (ProxyToolInfo: name/description/inputSchema), mirroring
// what proxy.listTools() -> discoverRemoteTools() would return at boot.
const fakeDiscoveredTools: ProxyToolInfo[] = [
	{
		name: "getIssue",
		description: "Fetch a Jira issue by key",
		inputSchema: { type: "object", properties: { issueKey: { type: "string" } }, required: ["issueKey"] },
	},
	{
		name: "searchIssues",
		description: "Search Jira issues by JQL",
		inputSchema: { type: "object", properties: { jql: { type: "string" } }, required: ["jql"] },
	},
];

function makeDatasource(discoveredTools: ProxyToolInfo[]): AtlassianDatasource {
	return {
		proxy: stubProxy,
		config: fakeConfig,
		discoveredTools,
		siteUrl: "https://example.atlassian.net",
	};
}

async function toolNames(server: McpServer): Promise<string[]> {
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	const client = new Client({ name: "atlassian-factory-replay-test-client", version: "0.0.0" });
	await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
	const { tools } = await client.listTools();
	await client.close();
	return tools.map((t) => t.name).sort();
}

describe("SIO-1044: atlassian-mcp-server cached factory replay", () => {
	test("replayed servers expose an identical tool list across calls", async () => {
		const factory = createMcpServerFactory(makeDatasource(fakeDiscoveredTools));

		const namesA = await toolNames(factory());
		const namesB = await toolNames(factory());

		expect(namesA).toEqual(namesB);
		expect(namesA.length).toBeGreaterThan(0);
	});

	test("replayed tool list matches a directly-registered control server, including proxy + custom tools", async () => {
		const ds = makeDatasource(fakeDiscoveredTools);
		const factory = createMcpServerFactory(ds);
		const replayed = await toolNames(factory());

		const control = new McpServer({ name: ds.config.application.name, version: ds.config.application.version });
		registerProxyTools(control, ds.proxy, ds.discoveredTools, { readOnly: ds.config.atlassian.readOnly });
		registerCustomTools(control, ds.proxy, {
			incidentProjects: ds.config.atlassian.incidentProjects,
			siteUrl: ds.siteUrl,
		});
		const controlNames = await toolNames(control);

		expect(replayed).toEqual(controlNames);
		expect(replayed).toContain("atlassian_getIssue");
		expect(replayed).toContain("atlassian_searchIssues");
		// Custom tools (find-linked-incidents, get-runbook-for-alert, get-incident-history,
		// get-jira-issue) are registered by registerCustomTools -- assert at least one is present
		// without pinning every custom tool name to this test.
		expect(replayed.length).toBeGreaterThan(fakeDiscoveredTools.length);
	});

	test("discoveredTools: [] still yields the custom tools (proxy tools are simply absent)", async () => {
		const factory = createMcpServerFactory(makeDatasource([]));
		const names = await toolNames(factory());

		expect(names).not.toContain("atlassian_getIssue");
		expect(names).not.toContain("atlassian_searchIssues");
		expect(names.length).toBeGreaterThan(0);
	});
});

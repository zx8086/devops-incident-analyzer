// src/__tests__/factory-replay.test.ts
// SIO-1044: gitlab-mcp-server adopts the shared record-once/replay-many factory. This is an
// upstream-proxy server -- discoveredTools is a boot-time snapshot (initDatasource discovers it
// once via discoverRemoteTools), so registerAll iterating that frozen array at boot is sound.
// This test locks in replay equivalence -- a replayed server's tool list must match both a
// second replay and a directly-registered control server built from the same stubs.
import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../config/index.js";
import type { GitLabRestClient } from "../gitlab-client/index.js";
import type { GitLabMcpProxy, ProxyToolInfo } from "../gitlab-client/proxy.js";
import { createMcpServerFactory, type GitLabDatasource } from "../server.js";
import { registerCodeAnalysisTools } from "../tools/code-analysis-registry.js";
import { registerProxyTools } from "../tools/proxy/index.js";

// Registration never calls the proxy/REST client (handlers run only on tools/call), so a
// minimal stub is sufficient for a tools/list-only test. handlers are never invoked here.
const stubProxy = {
	callTool: async () => ({ content: [] }),
	listTools: async () => [],
} as unknown as GitLabMcpProxy;

const stubRestClient = {} as unknown as GitLabRestClient;

const fakeConfig = {
	application: { name: "gitlab-mcp-server", version: "0.0.0" },
} as unknown as Config;

// Shaped like the real discovery output (ProxyToolInfo: name/description/inputSchema), mirroring
// what proxy.listTools() -> discoverRemoteTools() would return at boot.
const fakeDiscoveredTools: ProxyToolInfo[] = [
	{
		name: "get_project",
		description: "Fetch a GitLab project by id",
		inputSchema: { type: "object", properties: { project_id: { type: "string" } }, required: ["project_id"] },
	},
	{
		name: "list_issues",
		description: "List GitLab issues for a project",
		inputSchema: { type: "object", properties: { project_id: { type: "string" } }, required: ["project_id"] },
	},
];

function makeDatasource(discoveredTools: ProxyToolInfo[] | undefined): GitLabDatasource {
	return {
		proxy: stubProxy,
		restClient: stubRestClient,
		config: fakeConfig,
		discoveredTools,
	};
}

async function toolNames(server: McpServer): Promise<string[]> {
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	const client = new Client({ name: "gitlab-factory-replay-test-client", version: "0.0.0" });
	await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
	const { tools } = await client.listTools();
	await client.close();
	return tools.map((t) => t.name).sort();
}

describe("SIO-1044: gitlab-mcp-server cached factory replay", () => {
	test("replayed servers expose an identical tool list across calls", async () => {
		const factory = createMcpServerFactory(makeDatasource(fakeDiscoveredTools));

		const namesA = await toolNames(factory());
		const namesB = await toolNames(factory());

		expect(namesA).toEqual(namesB);
		expect(namesA.length).toBeGreaterThan(0);
	});

	test("replayed tool list matches a directly-registered control server, including proxy + code-analysis tools", async () => {
		const ds = makeDatasource(fakeDiscoveredTools);
		const factory = createMcpServerFactory(ds);
		const replayed = await toolNames(factory());

		const control = new McpServer({ name: ds.config.application.name, version: ds.config.application.version });
		registerProxyTools(control, ds.proxy, ds.discoveredTools ?? [], ds.restClient);
		registerCodeAnalysisTools(control, ds.restClient);
		const controlNames = await toolNames(control);

		expect(replayed).toEqual(controlNames);
		expect(replayed).toContain("gitlab_get_project");
		expect(replayed).toContain("gitlab_list_issues");
		// Code-analysis tools (get-file-content, get-blame, get-commit-diff, list-commits,
		// get-repository-tree, list-merge-requests) are registered by registerCodeAnalysisTools.
		expect(replayed.length).toBeGreaterThan(fakeDiscoveredTools.length);
	});

	test("discoveredTools: [] skips proxy registration entirely -- replayed server still has code-analysis tools", async () => {
		const factory = createMcpServerFactory(makeDatasource([]));
		const names = await toolNames(factory());

		expect(names).not.toContain("gitlab_get_project");
		expect(names).not.toContain("gitlab_list_issues");
		expect(names.length).toBeGreaterThan(0);
	});
});

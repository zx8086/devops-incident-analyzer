// src/__tests__/factory-replay.test.ts
// SIO-1044: gitlab-mcp-server adopts the shared record-once/replay-many factory. This is an
// upstream-proxy server -- discoveredTools is a boot-time snapshot (initDatasource discovers it
// once via discoverRemoteTools), so registerAll iterating that frozen array at boot is sound.
// This test locks in replay equivalence -- a replayed server's tool list must match both a
// second replay and a directly-registered control server built from the same stubs.
import { describe, expect, mock, test } from "bun:test";
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

	// Regression: GitLab's upstream /api/v4/mcp tool surface can add a tool under the same name
	// as a hand-written code-analysis tool (list_merge_requests -> gitlab_list_merge_requests,
	// SIO-771) at any time. Without excludeToolsShadowedByCodeAnalysis, registerCodeAnalysisTools
	// (registered second) throws "Tool gitlab_list_merge_requests is already registered" and the
	// whole server fails to boot -- this must resolve to the custom tool winning instead.
	test("a discovered proxy tool colliding with a code-analysis tool name does not crash boot -- custom tool wins", async () => {
		const collidingDiscoveredTools: ProxyToolInfo[] = [
			...fakeDiscoveredTools,
			{
				name: "list_merge_requests",
				description: "Upstream GitLab proxy's own merge-request listing tool",
				inputSchema: { type: "object", properties: { project_id: { type: "string" } }, required: ["project_id"] },
			},
		];

		const factory = createMcpServerFactory(makeDatasource(collidingDiscoveredTools));
		const names = await toolNames(factory());

		expect(names.filter((n) => n === "gitlab_list_merge_requests")).toHaveLength(1);
		expect(names).toContain("gitlab_get_project");
		expect(names).toContain("gitlab_list_issues");
	});

	// CodeRabbit (PR #588): the tool-list assertion above proves only that the name is registered
	// once, not that the CUSTOM handler is the one that ends up bound to it. Invoke the tool
	// through a real client and assert restClient.listMergeRequests (the custom handler's
	// dependency) is called while proxy.callTool (the shadowed upstream handler's dependency)
	// is not.
	test("the colliding tool's handler is the custom code-analysis one, not the shadowed proxy passthrough", async () => {
		const collidingDiscoveredTools: ProxyToolInfo[] = [
			{
				name: "list_merge_requests",
				description: "Upstream GitLab proxy's own merge-request listing tool",
				inputSchema: { type: "object", properties: { project_id: { type: "string" } }, required: ["project_id"] },
			},
		];

		const proxyCallToolSpy = mock(async () => ({ content: [] }));
		const spiedProxy = { ...stubProxy, callTool: proxyCallToolSpy } as unknown as GitLabMcpProxy;

		const listMergeRequestsSpy = mock(async (_projectId: number, _options?: Record<string, unknown>) => []);
		const spiedRestClient = { listMergeRequests: listMergeRequestsSpy } as unknown as GitLabRestClient;

		const ds: GitLabDatasource = {
			proxy: spiedProxy,
			restClient: spiedRestClient,
			config: fakeConfig,
			discoveredTools: collidingDiscoveredTools,
		};
		const server = createMcpServerFactory(ds)();

		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		const client = new Client({ name: "gitlab-collision-handler-test-client", version: "0.0.0" });
		await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
		await client.callTool({ name: "gitlab_list_merge_requests", arguments: { project_id: 42 } });
		await client.close();

		expect(listMergeRequestsSpy).toHaveBeenCalledTimes(1);
		expect(listMergeRequestsSpy.mock.calls[0]?.[0]).toBe(42);
		expect(proxyCallToolSpy).not.toHaveBeenCalled();
	});

	// SIO-1076: Orbit tools register only when config.orbit.enabled is true, and the
	// tool surface is stable regardless of boot availability (handlers soft-fail).
	test("orbit tools register when enabled and are absent when disabled", async () => {
		const disabled = await toolNames(createMcpServerFactory(makeDatasource([]))());
		expect(disabled).not.toContain("gitlab_blast_radius");

		const enabledDs: GitLabDatasource = {
			proxy: stubProxy,
			restClient: stubRestClient,
			config: {
				application: { name: "gitlab-mcp-server", version: "0.0.0" },
				orbit: { enabled: true, maxQueriesPerRun: 8 },
			} as unknown as Config,
			discoveredTools: [],
			// orbitClient omitted on purpose: registration must NOT require a live client.
			orbitAvailable: false,
		};
		const enabled = await toolNames(createMcpServerFactory(enabledDs)());
		expect(enabled).toContain("gitlab_graph_schema");
		expect(enabled).toContain("gitlab_blast_radius");
		expect(enabled).toContain("gitlab_cross_project_callers");
		expect(enabled).toContain("gitlab_recent_deploys");
		expect(enabled).toContain("gitlab_pipeline_failures");
		expect(enabled).toContain("gitlab_recent_vulnerabilities");
		expect(enabled).toContain("gitlab_orbit_query_graph");
	});
});

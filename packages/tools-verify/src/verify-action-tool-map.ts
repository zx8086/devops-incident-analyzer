// src/verify-action-tool-map.ts
// SIO-1368: gitagent tool YAMLs declare tool_mapping.action_tool_map -- literal MCP tool
// names per action. packages/agent/src/sub-agent.ts's orderByDeclaration() intersects these
// against the live connected MCP server's tools/list and silently drops any name that
// doesn't exist there (no error, no log -- the sub-agent just gets fewer tools that turn).
// This script boots each mcp-server-* package in-process (no network, no credentials --
// same recipe as every package's src/__tests__/factory-replay.test.ts) and asserts every
// action_tool_map name actually exists in that server's real registered tool set.
//
// atlassian/gitlab are upstream-proxy servers: their full remote tool set is discovered via
// a live network call at boot (bypassed here, same as factory-replay.test.ts, with a stub
// discoveredTools: [] -- so only their locally-registered CUSTOM tools appear in the live
// set). A declared name found in that live set is a real, confirmed pass. A declared name
// NOT found is ambiguous -- it may be a real proxy-only tool this stub can't see, or a
// genuine typo -- so it is classified as skipped (not silently pass/fail) rather than
// reported as drift. elastic-iac's kg_* names get the same skip treatment for a different
// reason: they are served by the separate knowledge-graph MCP server, never by elastic-iac's
// own tools/list, so absence there is by design (see the classifyMissing comments below).

import { fileURLToPath } from "node:url";
import { getAllActionToolNames, loadAgent, type ToolDefinition } from "@devops-agent/gitagent-bridge";
import { createCachedServerFactory } from "@devops-agent/shared";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

// `bun run --filter` executes with cwd set to this package's directory, not the repo root, so
// agent YAML paths are resolved relative to this file instead of assuming a repo-root cwd.
// fileURLToPath (not URL.pathname) so a checkout path containing spaces or other characters
// needing percent-encoding still resolves to a real, decoded filesystem path.
const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

interface ServerAdapter {
	mcpServer: string;
	buildServer: () => McpServer;
	// Applied ONLY to names absent from the live set (a present name is always checked as a
	// pass, never skipped) -- classifies why an absent name is not a failure, e.g. (a)
	// upstream-proxy servers whose full tool set is only discoverable via a live network call
	// at boot (gitlab/atlassian share their `gitlab_*`/`atlassian_*` prefix between proxy and
	// locally-registered custom tools, so a present name is proof-positive it's a real local
	// tool -- absence is the only ambiguous case, and only for that prefix), or (b) tools
	// genuinely served by a DIFFERENT MCP server than the one this YAML's mcp_server names
	// (e.g. elastic-iac's kg_* tools, bound via packages/agent/src/iac/nodes.ts's infoTools()
	// from the separate knowledge-graph server, never from elastic-iac's own tools/list).
	classifyMissing?: (name: string) => string | undefined;
}

async function toolNames(server: McpServer): Promise<string[]> {
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	const client = new Client({ name: "verify-action-tool-map", version: "0.0.0" });
	await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
	const { tools } = await client.listTools();
	await client.close();
	return tools.map((t) => t.name);
}

async function buildAdapters(): Promise<ServerAdapter[]> {
	const [atlassian, gitlab, couchbase, kafka, elastic, konnect, konnectTracer, konnectElicitation, aws, elasticIac] =
		await Promise.all([
			import("@devops-agent/mcp-server-atlassian/src/server.ts"),
			import("@devops-agent/mcp-server-gitlab/src/server.ts"),
			import("@devops-agent/mcp-server-couchbase/src/server.ts"),
			import("@devops-agent/mcp-server-kafka/src/tools/index.ts"),
			import("@devops-agent/mcp-server-elastic/src/server.ts"),
			import("@devops-agent/mcp-server-konnect/src/server.ts"),
			import("@devops-agent/mcp-server-konnect/src/utils/tool-tracer.ts"),
			import("@devops-agent/mcp-server-konnect/src/tools/elicitation-tool.ts"),
			import("@devops-agent/mcp-server-aws/src/tools/register.ts"),
			import("@devops-agent/mcp-server-elastic-iac/src/server.ts"),
		]);

	const stubProxy = { callTool: async () => ({ content: [] }), listTools: async () => [] };

	return [
		{
			mcpServer: "atlassian",
			buildServer: () =>
				atlassian.createMcpServerFactory({
					proxy: stubProxy as never,
					config: {
						application: { name: "atlassian-mcp-server", version: "0.0.0" },
						atlassian: { readOnly: true, incidentProjects: ["INC"] },
					} as never,
					discoveredTools: [],
					siteUrl: "https://example.atlassian.net",
				})(),
			// Real proxied names are discovered remotely at boot; discoveredTools: [] above
			// means none register here. A present name is proof it's a real local (custom)
			// tool; an ABSENT atlassian_* name is ambiguous (could be a real proxy tool this
			// stub can't see, or a genuine typo) so it's classified as skipped, not failed.
			classifyMissing: (name) => (name.startsWith("atlassian_") ? "proxy-discovered at boot, not checked" : undefined),
		},
		{
			mcpServer: "gitlab",
			buildServer: () =>
				gitlab.createMcpServerFactory({
					proxy: stubProxy as never,
					restClient: {} as never,
					config: { application: { name: "gitlab-mcp-server", version: "0.0.0" } } as never,
					discoveredTools: [],
				})(),
			// gitlab's proxy AND custom/code-analysis/Orbit tools share the gitlab_* prefix, so a
			// present name is proof it's real; an absent gitlab_* name is ambiguous the same way
			// as atlassian above.
			classifyMissing: (name) => (name.startsWith("gitlab_") ? "proxy-discovered at boot, not checked" : undefined),
		},
		{
			mcpServer: "couchbase",
			buildServer: () =>
				couchbase.createMcpServerFactory({
					bucket: {} as never,
					playbooks: null as never,
				})(),
		},
		{
			mcpServer: "kafka",
			buildServer: () =>
				createCachedServerFactory({
					createBareServer: () => new McpServer({ name: "@devops-agent/mcp-server-kafka", version: "0.0.0" }),
					registerAll: (server) =>
						kafka.registerAllTools(
							server,
							{} as never,
							{
								kafka: {
									provider: "local",
									clientId: "verify-action-tool-map",
									allowWrites: true,
									allowDestructive: true,
									consumeMaxMessages: 100,
									consumeTimeoutMs: 5000,
									toolTimeoutMs: 5000,
								},
								msk: { bootstrapBrokers: "", clusterArn: "", region: "", authMode: "iam" },
								confluent: { bootstrapServers: "", apiKey: "", apiSecret: "", restEndpoint: "", clusterId: "" },
								local: { bootstrapServers: "localhost:9092" },
								schemaRegistry: { enabled: true, url: "http://schema-registry:8081", apiKey: "", apiSecret: "" },
								ksql: { enabled: true, endpoint: "http://ksql-server:8088", apiKey: "", apiSecret: "" },
								connect: { enabled: true, url: "http://connect:8083", apiKey: "", apiSecret: "" },
								restproxy: { enabled: true, url: "http://kafka-rest:8082", apiKey: "", apiSecret: "" },
								logging: { level: "silent", backend: "pino" },
								telemetry: { enabled: false, serviceName: "kafka-mcp-server", mode: "console", otlpEndpoint: "" },
								transport: {
									mode: "stdio",
									port: 9081,
									host: "0.0.0.0",
									path: "/mcp",
									sessionMode: "stateless",
									apiKey: "",
									allowedOrigins: "",
									idleTimeout: 30,
									drainTimeoutMs: 0,
								},
							} as never,
							{
								schemaRegistryService: {} as never,
								ksqlService: {} as never,
								connectService: {} as never,
								restProxyService: {} as never,
							},
						),
				})(),
		},
		{
			mcpServer: "elastic",
			buildServer: () =>
				elastic.createMcpServerFactory(
					{ server: { name: "verify-action-tool-map", version: "0.0.0", readOnlyMode: false } } as never,
					{} as never,
					// Cloud + billing tools (16, e.g. elasticsearch_cloud_*, elasticsearch_billing_*)
					// register only when this arg is truthy (real boot: EC_API_KEY set). Registration
					// only closes over the client for later handler use, never calls it, so an inert
					// stub is enough to include those 16 tools in the checked set here.
					{} as never,
				)(),
		},
		{
			mcpServer: "konnect",
			buildServer: () =>
				konnect.createMcpServerFactory({
					api: {} as never,
					config: { application: { name: "kong-konnect-mcp", version: "2.0.0" } } as never,
					performanceCollector: new konnectTracer.ToolPerformanceCollector(),
					elicitationOps: new konnectElicitation.ElicitationOperations(),
				} as never)(),
		},
		{
			mcpServer: "aws",
			buildServer: () =>
				createCachedServerFactory({
					createBareServer: () => new McpServer({ name: "aws-mcp-server", version: "0.0.0" }),
					registerAll: (server) =>
						aws.registerAllTools(server, {
							region: "eu-central-1",
							estates: {
								prod: {
									assumedRoleArn: "arn:aws:iam::000000000000:role/DevOpsAgentReadOnly",
									externalId: "verify-action-tool-map",
								},
							},
						} as never),
				})(),
		},
		{
			mcpServer: "elastic-iac",
			buildServer: () =>
				elasticIac.createMcpServerFactory({
					transport: { mode: "http", port: 0, host: "127.0.0.1", path: "/mcp" },
					repository: {
						gitlabBaseUrl: "https://gitlab.example.com",
						projectId: "1",
						workspaceDir: "/tmp/verify-action-tool-map",
					},
					gitops: { baseUrl: "https://gitlab.example.com", project: "example/elastic-iac", token: undefined },
					taskBin: "task",
					gitlabToken: undefined,
					elasticCloudApiKey: undefined,
					elasticCloudBaseUrl: "https://api.elastic-cloud.com",
					clusterDeployments: [],
				} as never)(),
			// SIO-967 (see the YAML's own tool_mapping comment): kg_* tools are served by the
			// separate in-process knowledge-graph MCP server, not elastic-iac's own server --
			// bound directly via packages/agent/src/iac/nodes.ts's infoTools(), outside
			// selectToolsByAction entirely. They are declared here only to keep the facade
			// pattern matcher from filtering them out, so checking them against elastic-iac's
			// own tools/list is the wrong comparison by design, not drift.
			classifyMissing: (name) =>
				name.startsWith("kg_") ? "served by knowledge-graph server via infoTools(), not checked" : undefined,
		},
	];
}

interface Diagnostic {
	yaml: string;
	toolName: string;
	action: string;
	missing: string;
}

async function main() {
	const [incidentAnalyzer, elasticIacAgent, adapters] = await Promise.all([
		Promise.resolve(loadAgent(`${REPO_ROOT}agents/incident-analyzer`)),
		Promise.resolve(loadAgent(`${REPO_ROOT}agents/elastic-iac`)),
		buildAdapters(),
	]);

	const allTools: { toolDef: ToolDefinition; yamlAgent: string }[] = [
		...incidentAnalyzer.tools.map((toolDef) => ({ toolDef, yamlAgent: "incident-analyzer" })),
		...elasticIacAgent.tools.map((toolDef) => ({ toolDef, yamlAgent: "elastic-iac" })),
	].filter(({ toolDef }) => toolDef.tool_mapping?.action_tool_map);

	const adapterByServer = new Map(adapters.map((a) => [a.mcpServer, a]));
	const diagnostics: Diagnostic[] = [];
	const skipReasonCounts = new Map<string, number>();
	// A YAML whose mcp_server has no adapter here would otherwise silently skip verification
	// (0 names checked, no diagnostic, exit 0) -- tracked separately and treated as a hard
	// failure below so a new datasource YAML can never pass by going unchecked.
	const unverified: string[] = [];
	let totalChecked = 0;

	for (const { toolDef } of allTools) {
		const server = toolDef.tool_mapping?.mcp_server;
		if (!server) continue;
		const adapter = adapterByServer.get(server);
		if (!adapter) {
			unverified.push(`${toolDef.name} (mcp_server "${server}")`);
			continue;
		}

		const liveNames = new Set(await toolNames(adapter.buildServer()));
		const actionMap = toolDef.tool_mapping?.action_tool_map ?? {};

		for (const [action, names] of Object.entries(actionMap)) {
			for (const name of names) {
				totalChecked++;
				if (liveNames.has(name)) continue;
				const skipReason = adapter.classifyMissing?.(name);
				if (skipReason) {
					skipReasonCounts.set(skipReason, (skipReasonCounts.get(skipReason) ?? 0) + 1);
					continue;
				}
				diagnostics.push({ yaml: toolDef.name, toolName: name, action, missing: name });
			}
		}
	}

	// getAllActionToolNames is the same union-of-all-actions helper sub-agent.ts's
	// orderByDeclaration relies on. This total is informational only -- it dedupes names
	// within each tool definition (the per-action loop above counts every occurrence) and
	// includes YAMLs that had no adapter, so it is not a cross-check against totalChecked.
	const totalDeclared = allTools.reduce((sum, { toolDef }) => sum + getAllActionToolNames(toolDef).length, 0);
	const totalSkipped = [...skipReasonCounts.values()].reduce((sum, n) => sum + n, 0);

	console.log(`Checked ${totalChecked} action_tool_map names against live MCP tools/list.`);
	console.log(`Skipped ${totalSkipped} names (not counted as pass or fail):`);
	for (const [reason, count] of skipReasonCounts) {
		console.log(`  ${count}x: ${reason}`);
	}
	console.log(`(${totalDeclared} total unique declared names across ${allTools.length} tool definitions.)`);

	if (unverified.length > 0) {
		console.error(`\n${unverified.length} tool definition(s) have no adapter and were never verified:\n`);
		for (const name of unverified) {
			console.error(`  ${name}`);
		}
		console.error("\nAdd an adapter in buildAdapters() for each mcp_server listed above.");
		process.exit(1);
	}

	if (diagnostics.length > 0) {
		console.error(`\n${diagnostics.length} action_tool_map name(s) not found in the live MCP server tool list:\n`);
		for (const d of diagnostics) {
			console.error(`  ${d.yaml} -> action "${d.action}" -> "${d.missing}" (no matching live MCP tool)`);
		}
		console.error("\nThese names will be silently dropped at runtime by sub-agent.ts's orderByDeclaration().");
		process.exit(1);
	}

	console.log("\nAll action_tool_map names resolved against live MCP tools. OK.");
	// Explicit exit: booting 8 in-process MCP servers can leave lingering handles (open
	// InMemoryTransport pairs, service stub timers) that keep the event loop alive after
	// main() resolves, so the process would otherwise hang instead of returning to the shell.
	process.exit(0);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});

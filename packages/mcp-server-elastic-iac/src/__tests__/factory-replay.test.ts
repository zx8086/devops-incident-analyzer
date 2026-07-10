// src/__tests__/factory-replay.test.ts
// SIO-1044: elastic-iac-mcp-server adopts the shared record-once/replay-many factory. This test
// locks in replay equivalence -- a replayed server's tool list must match both a second replay
// and the back-compat createServer control, so nothing is silently dropped or duplicated by the
// record.
import { describe, expect, test } from "bun:test";
import { createCachedServerFactory } from "@devops-agent/shared";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import pkg from "../../package.json" with { type: "json" };
import type { Config } from "../config.ts";
import { createMcpServerFactory, createServer } from "../server.ts";
import { registerElasticTools } from "../tools/elastic.ts";
import { registerGitlabTools } from "../tools/gitlab.ts";
import { registerIacTools } from "../tools/iac.ts";
import { registerTerraformTools } from "../tools/terraform.ts";

// Registration never calls GitLab/Elastic Cloud/task (handlers run only on tools/call), so a
// minimal stub config is sufficient for a tools/list-only test.
const fakeConfig: Config = {
	transport: { mode: "http", port: 0, host: "127.0.0.1", path: "/mcp" },
	repository: {
		gitlabBaseUrl: "https://gitlab.example.com",
		projectId: "1",
		workspaceDir: "/tmp/elastic-iac-factory-replay-test",
	},
	gitops: {
		baseUrl: "https://gitlab.example.com",
		project: "example/elastic-iac",
		token: undefined,
	},
	taskBin: "task",
	gitlabToken: undefined,
	elasticCloudApiKey: undefined,
	elasticCloudBaseUrl: "https://api.elastic-cloud.com",
	clusterDeployments: [],
};

async function toolNames(server: McpServer): Promise<string[]> {
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	const client = new Client({ name: "elastic-iac-factory-replay-test-client", version: "0.0.0" });
	await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
	const { tools } = await client.listTools();
	await client.close();
	return tools.map((t) => t.name).sort();
}

describe("SIO-1044: elastic-iac-mcp-server cached factory replay", () => {
	test("replayed servers expose an identical tool list across calls", async () => {
		const factory = createMcpServerFactory(fakeConfig);

		const namesA = await toolNames(factory());
		const namesB = await toolNames(factory());

		expect(namesA).toEqual(namesB);
		expect(namesA.length).toBeGreaterThan(0);
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
		// factory with the package's real four registrars wrapped in a spy to observe the
		// boot-time-only contract directly, instead of trusting the shared unit test alone.
		let registerAllCalls = 0;
		const factory = createCachedServerFactory({
			createBareServer: () => new McpServer({ name: "elastic-iac-mcp-server", version: pkg.version }),
			registerAll: (server) => {
				registerAllCalls++;
				registerTerraformTools(server, fakeConfig);
				registerGitlabTools(server, fakeConfig);
				registerElasticTools(server, fakeConfig);
				registerIacTools(server, fakeConfig);
			},
		});

		expect(registerAllCalls).toBe(1);
		factory();
		factory();
		expect(registerAllCalls).toBe(1);
	});
});

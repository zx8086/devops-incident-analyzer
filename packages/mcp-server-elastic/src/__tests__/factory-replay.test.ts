// src/__tests__/factory-replay.test.ts
// SIO-1050: elasticsearch_get_aliases was registered via the legacy server.tool() sugar, which
// the original recorder (pre-SIO-1044) did not capture -- the tool existed only on the discarded
// boot template and was missing from every replayed per-request server. Task 1 (SIO-1044) extended
// the shared factory to record all six registration methods; this test locks in the regression so
// a future legacy-API tool cannot silently reintroduce the same gap.
import { describe, expect, test } from "bun:test";
import { connectV1TestClient } from "@devops-agent/shared/src/testing/mcp-test-client.ts";
import type { Client } from "@elastic/elasticsearch";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../config/index.js";
import { createMcpServerFactory, createMcpServerInstance } from "../server.js";

// Registration never calls the ES client (handlers are invoked only on tools/call), so a stub
// object is sufficient for a tools/list-only test.
const esClientStub = {} as Partial<Client> as unknown as Client;

const fakeConfig = {
	server: { name: "elastic-factory-replay-test", version: "0.0.0", readOnlyMode: false },
} as unknown as Config;

async function toolNames(serverFactory: () => McpServer): Promise<string[]> {
	const client = await connectV1TestClient(serverFactory, "factory-replay-test-client");
	const { tools } = await client.listTools();
	await client.close();
	return tools.map((t) => t.name).sort();
}

describe("SIO-1050: elastic factory replay regression", () => {
	test("replayed servers expose an identical tool list across calls, including elasticsearch_get_aliases", async () => {
		const factory = createMcpServerFactory(fakeConfig, esClientStub, null);

		const namesA = await toolNames(factory);
		const namesB = await toolNames(factory);

		expect(namesA).toEqual(namesB);
		expect(namesA).toContain("elasticsearch_get_aliases");
	});

	test("replayed tool list matches the non-cached back-compat constructor", async () => {
		const factory = createMcpServerFactory(fakeConfig, esClientStub, null);
		const replayed = await toolNames(factory);

		const control = () => {
			const server = createMcpServerInstance(fakeConfig, esClientStub, null);
			return server;
		};
		const controlNames = await toolNames(control);

		expect(replayed).toEqual(controlNames);
		expect(controlNames).toContain("elasticsearch_get_aliases");
	});
});

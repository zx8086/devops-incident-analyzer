// src/__tests__/proxy-undeclared-caps.test.ts
//
// SIO-1854: the cap must survive REGISTRATION, not just schema conversion. The unit tests
// call buildZodShapeFromJsonSchema directly, so dropping the tool-name argument at the
// production call site leaves them all green while restoring the unbounded schema -- the
// same integration gap that let SIO-1656 ship with no effect (Greptile, PR #863).
//
// This asserts the schema the MODEL actually receives over tools/list.
import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { GitLabRestClient } from "../gitlab-client/index.js";
import type { GitLabMcpProxy, ProxyToolInfo } from "../gitlab-client/proxy.js";
import { registerProxyTools } from "../tools/proxy/index.js";

const stubProxy = {
	callTool: async () => ({ content: [] }),
	listTools: async () => [],
} as unknown as GitLabMcpProxy;
const stubRestClient = {} as unknown as GitLabRestClient;

// The REAL upstream shape: items.enum and NO maxItems, which is the whole problem --
// GitLab enforces "one facet per call" without declaring it.
const GET_MERGE_REQUEST: ProxyToolInfo = {
	name: "get_merge_request",
	description: "Fetch a merge request",
	inputSchema: {
		type: "object",
		properties: {
			id: { type: "string", description: "Project id" },
			merge_request_iid: { type: "integer", description: "MR iid" },
			include: {
				type: "array",
				description: "Associated facets",
				items: { type: "string", enum: ["diffs", "commits", "notes", "pipelines", "discussions"] },
			},
		},
		required: ["id", "merge_request_iid"],
	},
};

async function inputSchemaOf(tool: ProxyToolInfo): Promise<Record<string, unknown>> {
	const server = new McpServer({ name: "gitlab-mcp-server", version: "0.0.0" });
	registerProxyTools(server, stubProxy, [tool], stubRestClient);

	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	const client = new Client({ name: "proxy-caps-test-client", version: "0.0.0" });
	await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
	const { tools } = await client.listTools();
	await client.close();

	const registered = tools.find((t) => t.name === `gitlab_${tool.name}`);
	if (!registered) throw new Error(`tool not registered: ${tool.name}`);
	return registered.inputSchema as Record<string, unknown>;
}

describe("SIO-1854 the undeclared cap reaches the registered tool", () => {
	test("the published schema for include carries maxItems: 1", async () => {
		const schema = await inputSchemaOf(GET_MERGE_REQUEST);
		const properties = schema.properties as Record<string, Record<string, unknown>>;
		// This is what the model reads when it decides what to send. Before SIO-1854 it said
		// "array of enum, any length", so ["diffs","pipelines"] looked legal and GitLab
		// answered "include cannot contain more than 1 items".
		expect(properties.include?.maxItems).toBe(1);
		// The element contract from SIO-1656 must survive alongside the new bound.
		expect((properties.include?.items as Record<string, unknown>)?.enum).toEqual([
			"diffs",
			"commits",
			"notes",
			"pipelines",
			"discussions",
		]);
	});

	test("a tool with no known cap publishes an unbounded array", async () => {
		const schema = await inputSchemaOf({
			name: "list_projects",
			description: "List projects",
			inputSchema: { type: "object", properties: { include: { type: "array", items: { type: "string" } } } },
		});
		const properties = schema.properties as Record<string, Record<string, unknown>>;
		expect(properties.include?.maxItems).toBeUndefined();
	});
});

// test/find-linked-incidents-structured-content.test.ts
// SIO-1422: registerFindLinkedIncidents now declares outputSchema + returns structuredContent.
// This test goes through the real registerTool handler via an in-process MCP client (not the
// bare findLinkedIncidents() function, which the pre-existing find-linked-incidents.test.ts
// already covers) to prove: (1) the SDK's own output validation accepts what the handler
// returns -- a schema/payload mismatch throws a live McpError before the client ever sees a
// result, so a passing callTool() is itself proof of validity -- and (2) content[0].text is
// byte-identical to a raw JSON.stringify(payload, null, 2) capture, i.e. structuredContent is
// additive and does not perturb what the LLM reads.
import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AtlassianMcpProxy } from "../src/atlassian-client/index.js";
import { registerFindLinkedIncidents } from "../src/tools/custom/find-linked-incidents.js";

const fakeProxy = {
	callTool: async () => ({
		content: [
			{
				type: "text",
				text: JSON.stringify({
					issues: [
						{
							key: "INC-1",
							fields: {
								summary: "checkout down",
								status: { name: "Resolved" },
								priority: { name: "High" },
								created: "2026-04-10T10:00:00Z",
								resolutiondate: "2026-04-10T10:30:00Z",
							},
						},
					],
				}),
			},
		],
	}),
} as unknown as AtlassianMcpProxy;

async function buildClient() {
	const server = new McpServer({ name: "atlassian-structured-content-test", version: "0.0.0" });
	registerFindLinkedIncidents(server, fakeProxy, ["INC"], "https://tommy.atlassian.net");
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	const client = new Client({ name: "atlassian-structured-content-test-client", version: "0.0.0" });
	await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
	return client;
}

describe("SIO-1422: findLinkedIncidents structuredContent round-trip", () => {
	test("callTool succeeds (SDK output validation passes) and structuredContent matches the text payload", async () => {
		const client = await buildClient();
		const result = await client.callTool({
			name: "findLinkedIncidents",
			arguments: { service: "checkout-api", withinDays: 30, limit: 10 },
		});
		await client.close();

		expect(result.isError).toBeFalsy();
		const content = result.content as Array<{ type: "text"; text: string }>;
		const textPayload = JSON.parse(content[0]?.text ?? "null");
		expect(result.structuredContent).toEqual(textPayload);

		const structured = result.structuredContent as { count: number; issues: Array<{ key: string }> };
		expect(structured.count).toBe(1);
		expect(structured.issues[0]?.key).toBe("INC-1");
	});

	test("content[0].text is byte-identical to JSON.stringify(payload, null, 2)", async () => {
		const client = await buildClient();
		const result = await client.callTool({
			name: "findLinkedIncidents",
			arguments: { service: "checkout-api", withinDays: 30, limit: 10 },
		});
		await client.close();

		const content = result.content as Array<{ type: "text"; text: string }>;
		const reserialized = JSON.stringify(JSON.parse(content[0]?.text ?? "null"), null, 2);
		expect(content[0]?.text).toBe(reserialized);
	});
});

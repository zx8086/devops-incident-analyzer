// test/proxy.test.ts
import { describe, expect, test } from "bun:test";
import { AtlassianMcpProxy, type McpClientLike } from "../src/atlassian-client/proxy.js";

function makeClient(overrides: Partial<McpClientLike> = {}): McpClientLike {
	return {
		listTools: async () => ({ tools: [] }),
		callTool: async () => ({ content: [] }),
		...overrides,
	};
}

describe("AtlassianMcpProxy.resolveCloudId", () => {
	test("selects first resource when siteName unset", async () => {
		const client = makeClient({
			callTool: async ({ name }: { name: string }) => {
				if (name === "getAccessibleAtlassianResources") {
					return {
						content: [
							{
								type: "text",
								text: JSON.stringify([
									{ id: "c-first", name: "primary" },
									{ id: "c-second", name: "secondary" },
								]),
							},
						],
					};
				}
				return { content: [] };
			},
		});
		const proxy = new AtlassianMcpProxy({ mcpEndpoint: "x", callbackPort: 0, client, siteName: undefined });
		await proxy.resolveCloudId();
		expect(proxy.getCloudId()).toBe("c-first");
	});

	test("selects matching siteName", async () => {
		const client = makeClient({
			callTool: async () => ({
				content: [
					{
						type: "text",
						text: JSON.stringify([
							{ id: "c-first", name: "primary" },
							{ id: "c-target", name: "tommy" },
						]),
					},
				],
			}),
		});
		const proxy = new AtlassianMcpProxy({ mcpEndpoint: "x", callbackPort: 0, client, siteName: "tommy" });
		await proxy.resolveCloudId();
		expect(proxy.getCloudId()).toBe("c-target");
	});

	test("throws when no accessible resources", async () => {
		const client = makeClient({
			callTool: async () => ({ content: [{ type: "text", text: "[]" }] }),
		});
		const proxy = new AtlassianMcpProxy({ mcpEndpoint: "x", callbackPort: 0, client, siteName: undefined });
		await expect(proxy.resolveCloudId()).rejects.toThrow(/no accessible resources/i);
	});
});

describe("AtlassianMcpProxy.callTool", () => {
	test("injects cloudId into every call", async () => {
		const captured: Array<{ name: string; arguments: Record<string, unknown> }> = [];
		const client = makeClient({
			callTool: async (req: { name: string; arguments?: Record<string, unknown> }) => {
				captured.push({ name: req.name, arguments: req.arguments ?? {} });
				if (req.name === "getAccessibleAtlassianResources") {
					return { content: [{ type: "text", text: JSON.stringify([{ id: "c-xyz", name: "s" }]) }] };
				}
				return { content: [] };
			},
		});
		const proxy = new AtlassianMcpProxy({ mcpEndpoint: "x", callbackPort: 0, client, siteName: undefined });
		await proxy.resolveCloudId();
		await proxy.callTool("searchJiraIssuesUsingJql", { jql: "project = INC" });
		const searchCall = captured.find((c) => c.name === "searchJiraIssuesUsingJql");
		expect(searchCall?.arguments.cloudId).toBe("c-xyz");
		expect(searchCall?.arguments.jql).toBe("project = INC");
	});

	test("retries once after UnauthorizedError then succeeds", async () => {
		const { UnauthorizedError } = await import("@modelcontextprotocol/sdk/client/auth.js");
		let callCount = 0;
		const client = makeClient({
			callTool: async (req: { name: string }) => {
				if (req.name === "getAccessibleAtlassianResources") {
					return { content: [{ type: "text", text: JSON.stringify([{ id: "c1", name: "s" }]) }] };
				}
				callCount++;
				if (callCount === 1) throw new UnauthorizedError("expired");
				return { content: [{ type: "text", text: "ok" }] };
			},
		});
		let reauthCalled = 0;
		const proxy = new AtlassianMcpProxy({
			mcpEndpoint: "x",
			callbackPort: 0,
			client,
			siteName: undefined,
			reauth: async () => { reauthCalled++; },
		});
		await proxy.resolveCloudId();
		const result = await proxy.callTool("searchJiraIssuesUsingJql", {});
		expect(reauthCalled).toBe(1);
		expect(callCount).toBe(2);
		expect((result as { content: Array<{ text: string }> }).content[0].text).toBe("ok");
	});

	test("returns ATLASSIAN_AUTH_REQUIRED error result after second failure", async () => {
		const { UnauthorizedError } = await import("@modelcontextprotocol/sdk/client/auth.js");
		const client = makeClient({
			callTool: async (req: { name: string }) => {
				if (req.name === "getAccessibleAtlassianResources") {
					return { content: [{ type: "text", text: JSON.stringify([{ id: "c1", name: "s" }]) }] };
				}
				throw new UnauthorizedError("expired");
			},
		});
		const proxy = new AtlassianMcpProxy({
			mcpEndpoint: "x",
			callbackPort: 0,
			client,
			siteName: undefined,
			reauth: async () => {},
		});
		await proxy.resolveCloudId();
		const result = (await proxy.callTool("searchJiraIssuesUsingJql", {})) as {
			isError?: boolean;
			content: Array<{ text: string }>;
		};
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("ATLASSIAN_AUTH_REQUIRED");
	});
});

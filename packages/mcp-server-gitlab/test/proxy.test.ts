// test/proxy.test.ts

import { describe, expect, test } from "bun:test";
import { GitLabMcpProxy, type McpClientLike } from "../src/gitlab-client/proxy.js";

function makeClient(overrides: Partial<McpClientLike> = {}): McpClientLike {
	return {
		listTools: async () => ({ tools: [] }),
		callTool: async () => ({ content: [] }),
		...overrides,
	};
}

const baseConfig = {
	instanceUrl: "https://gitlab.com",
	personalAccessToken: "pat",
	timeout: 30000,
	oauthCallbackPort: 9184,
};

describe("GitLabMcpProxy", () => {
	test("constructed with injected client reports as connected after connect()", async () => {
		const proxy = new GitLabMcpProxy({ config: baseConfig, client: makeClient() });
		await proxy.connect();
		expect(proxy.isConnected()).toBe(true);
	});

	test("listTools returns the proxy tools shape from the injected client", async () => {
		const client = makeClient({
			listTools: async () => ({
				tools: [
					{ name: "list_issues", description: "List GitLab issues", inputSchema: { type: "object" } },
					{ name: "get_project", description: "Get a GitLab project", inputSchema: { type: "object" } },
				],
			}),
		});
		const proxy = new GitLabMcpProxy({ config: baseConfig, client });
		await proxy.connect();
		const tools = await proxy.listTools();
		expect(tools).toHaveLength(2);
		expect(tools[0]?.name).toBe("list_issues");
	});

	test("callTool forwards name, args, and timeout to the injected client", async () => {
		const calls: Array<{ name: string; arguments?: Record<string, unknown>; timeout?: number }> = [];
		const client = makeClient({
			callTool: async (req, _schema, options?: { timeout?: number }) => {
				calls.push({ name: req.name, arguments: req.arguments, timeout: options?.timeout });
				return { ok: true };
			},
		});
		const proxy = new GitLabMcpProxy({ config: baseConfig, client });
		await proxy.connect();

		const result = await proxy.callTool("list_issues", { project_id: "42" }, { timeout: 5000 });
		expect(result).toEqual({ ok: true });
		expect(calls).toEqual([{ name: "list_issues", arguments: { project_id: "42" }, timeout: 5000 }]);
	});

	test("legacy positional config constructor still works", () => {
		const proxy = new GitLabMcpProxy(baseConfig);
		expect(proxy.isConnected()).toBe(false);
	});

	test("listTools throws when not connected", async () => {
		const proxy = new GitLabMcpProxy(baseConfig);
		await expect(proxy.listTools()).rejects.toThrow(/Not connected/i);
	});
});

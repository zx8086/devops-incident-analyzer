import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Config } from "./config.ts";
import { createServer } from "./server.ts";
import type { GitLabReadClient } from "./tools/repositories.ts";

const forbiddenSurface = /\b(create|update|delete|commit|branch|merge|apply|import|state|unlock|mutat(?:e|ion))\b/i;

describe("Landing Zone MCP server", () => {
	test("exposes only the six approved read tools", async () => {
		const config = {
			transport: { mode: "http", port: 0, host: "127.0.0.1", path: "/mcp" },
			gitlab: { baseUrl: "https://gitlab.example", token: undefined, timeoutMs: 30_000, maxResponseBytes: 200_000 },
		} satisfies Config;
		const client = {} as GitLabReadClient;
		const server = createServer(config, client);
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		const mcpClient = new Client({ name: "landing-zone-surface-test", version: "0.0.0" });
		await Promise.all([mcpClient.connect(clientTransport), server.connect(serverTransport)]);

		const { tools } = await mcpClient.listTools();
		await mcpClient.close();

		expect(tools.map((tool) => tool.name).sort()).toEqual([
			"lz_extract_terraform_topology",
			"lz_find_representative_examples",
			"lz_list_open_changes",
			"lz_list_repositories",
			"lz_read_pipeline_plan",
			"lz_read_repository_files",
		]);
		for (const tool of tools) {
			expect(`${tool.name} ${tool.description ?? ""}`).not.toMatch(forbiddenSurface);
			expect(tool.annotations?.readOnlyHint).toBe(true);
			expect(tool.annotations?.destructiveHint).toBe(false);
		}
	});
});

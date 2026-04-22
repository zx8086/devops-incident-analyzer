// tests/unit/tools/list_indices.test.ts

import { beforeAll, describe, expect, test } from "bun:test";
import type { Client } from "@elastic/elasticsearch";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerListIndicesTool } from "../../../src/tools/core/list_indices.js";
import { initializeReadOnlyManager } from "../../../src/utils/readOnlyMode.js";
import { getToolFromServer } from "../../utils/elasticsearch-client.js";

type CatRow = Record<string, string>;
type CatParams = { index?: string; format: "json"; h: string };
type ContentBlock = { type: string; text: string };
type ListIndicesResult = { content: ContentBlock[] };
type ListIndicesArgs = { sortBy?: "name" | "size" | "docs" | "creation"; includeSize?: boolean };
type Handler = (args: ListIndicesArgs) => Promise<ListIndicesResult>;

const fixtureRows: CatRow[] = [
	{
		index: "small-kb",
		health: "green",
		status: "open",
		"docs.count": "10",
		"store.size": "997.1kb",
		"store.size_in_bytes": "1021030",
		"creation.date.string": "2026-04-01T00:00:00Z",
	},
	{
		index: "medium-mb",
		health: "green",
		status: "open",
		"docs.count": "100",
		"store.size": "746.8mb",
		"store.size_in_bytes": "783091200",
		"creation.date.string": "2026-04-02T00:00:00Z",
	},
	{
		index: "large-gb",
		health: "green",
		status: "open",
		"docs.count": "1000000",
		"store.size": "12.3gb",
		"store.size_in_bytes": "13207024435",
		"creation.date.string": "2026-04-03T00:00:00Z",
	},
];

function makeStubClient(): { client: Client; calls: { last?: CatParams } } {
	const calls: { last?: CatParams } = {};
	const client = {
		cat: {
			indices: async (params: CatParams) => {
				calls.last = params;
				return fixtureRows;
			},
		},
	} as unknown as Client;
	return { client, calls };
}

describe("list_indices size sort (defect 7)", () => {
	let handler: Handler;
	let calls: { last?: CatParams };

	beforeAll(() => {
		initializeReadOnlyManager(false, false);
		const server = new McpServer({ name: "test", version: "1.0.0" });
		const stub = makeStubClient();
		calls = stub.calls;
		registerListIndicesTool(server, stub.client);
		const tool = getToolFromServer(server, "elasticsearch_list_indices");
		if (!tool) throw new Error("tool not registered");
		handler = tool.handler as Handler;
	});

	test("requests store.size_in_bytes from cat.indices when sorting by size", async () => {
		await handler({ sortBy: "size", includeSize: true });
		expect(calls.last?.h).toContain("store.size_in_bytes");
	});

	test("sorts by raw byte count, not lexicographic on formatted string", async () => {
		const result = await handler({ sortBy: "size", includeSize: true });
		const indicesJson = result.content[result.content.length - 1].text;
		const parsed = JSON.parse(indicesJson) as Array<{ index: string }>;
		expect(parsed.map((row) => row.index)).toEqual(["large-gb", "medium-mb", "small-kb"]);
	});

	test("preserves human-readable storeSize in the response payload", async () => {
		const result = await handler({ sortBy: "size", includeSize: true });
		const parsed = JSON.parse(result.content[result.content.length - 1].text) as Array<{ storeSize?: string }>;
		expect(parsed[0].storeSize).toBe("12.3gb");
	});
});

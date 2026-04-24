// tests/unit/tools/get_shards.test.ts

import { describe, expect, test } from "bun:test";
import type { Client } from "@elastic/elasticsearch";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerGetShardsTool } from "../../../src/tools/core/get_shards.js";
import { getToolFromServer } from "../../utils/elasticsearch-client.js";

type CatRow = Record<string, string>;
type CatParams = { index?: string; format: "json"; h: string; bytes?: "b" };
type ContentBlock = { type: string; text: string };
type GetShardsResult = { content: ContentBlock[] };
type GetShardsArgs = { index?: string; limit?: number; sortBy?: "state" | "index" | "size" | "docs" };
type Handler = (args: GetShardsArgs) => Promise<GetShardsResult>;

function makeStub(rows: CatRow[]): { client: Client; calls: { last?: CatParams } } {
	const calls: { last?: CatParams } = {};
	const client = {
		cat: {
			shards: async (params: CatParams) => {
				calls.last = params;
				return rows;
			},
		},
	} as unknown as Client;
	return { client, calls };
}

function makeHandler(rows: CatRow[]): { handler: Handler; calls: { last?: CatParams } } {
	const server = new McpServer({ name: "test", version: "1.0.0" });
	const { client, calls } = makeStub(rows);
	registerGetShardsTool(server, client);
	const tool = getToolFromServer(server, "elasticsearch_get_shards");
	if (!tool) throw new Error("tool not registered");
	return { handler: tool.handler as Handler, calls };
}

// SIO-660: cat.shards `store` is raw bytes only with bytes=b. These fixtures
// reflect what ES actually returns with that flag: integer strings.
const sizeFixture: CatRow[] = [
	{
		index: "small-kb",
		shard: "0",
		prirep: "p",
		state: "STARTED",
		docs: "10",
		store: "1021030",
		ip: "10.0.0.1",
		node: "node-1",
	},
	{
		index: "medium-mb",
		shard: "0",
		prirep: "p",
		state: "STARTED",
		docs: "100",
		store: "783091200",
		ip: "10.0.0.2",
		node: "node-2",
	},
	{
		index: "large-gb",
		shard: "0",
		prirep: "p",
		state: "STARTED",
		docs: "1000000",
		store: "13207024435",
		ip: "10.0.0.3",
		node: "node-3",
	},
];

describe("get_shards size sort (SIO-660)", () => {
	test("requests bytes=b when sorting by size so store is a raw integer", async () => {
		const { handler, calls } = makeHandler(sizeFixture);
		await handler({ sortBy: "size" });
		expect(calls.last?.bytes).toBe("b");
		expect(calls.last?.h).toContain("store");
	});

	test("does NOT request bytes=b for other sortBy values (store stays formatted)", async () => {
		const { handler, calls } = makeHandler([
			{ index: "a", shard: "0", prirep: "p", state: "STARTED", docs: "1", store: "12.3gb" },
		]);
		await handler({ sortBy: "state" });
		expect(calls.last?.bytes).toBeUndefined();
	});

	test("sorts by raw byte count descending, not lexicographic on formatted string", async () => {
		const { handler } = makeHandler(sizeFixture);
		const result = await handler({ sortBy: "size" });
		const shards = JSON.parse(result.content[2].text) as Array<{ index: string }>;
		expect(shards.map((s) => s.index)).toEqual(["large-gb", "medium-mb", "small-kb"]);
	});

	test("humanises store in the output payload when sorting by size", async () => {
		const { handler } = makeHandler(sizeFixture);
		const result = await handler({ sortBy: "size" });
		const shards = JSON.parse(result.content[2].text) as Array<{ store: string }>;
		expect(shards[0].store).toBe("12.3gb");
		expect(shards[1].store).toBe("746.8mb");
		expect(shards[2].store).toBe("997.1kb");
	});

	test("passes through pre-formatted store unchanged for non-size sortBy", async () => {
		const { handler } = makeHandler([
			{ index: "a", shard: "0", prirep: "p", state: "STARTED", docs: "1", store: "12.3gb" },
			{ index: "b", shard: "0", prirep: "p", state: "STARTED", docs: "2", store: "997.1kb" },
		]);
		const result = await handler({ sortBy: "docs" });
		const shards = JSON.parse(result.content[2].text) as Array<{ store: string }>;
		// Already human-formatted; should not be mangled.
		expect(shards[0].store).toBe("997.1kb");
		expect(shards[1].store).toBe("12.3gb");
	});

	test("sortBy=size excludes shards missing store (unassigned/closed) and discloses count", async () => {
		const rows: CatRow[] = [
			{ index: "good-small", shard: "0", prirep: "p", state: "STARTED", docs: "10", store: "1000" },
			{ index: "good-large", shard: "0", prirep: "p", state: "STARTED", docs: "100", store: "50000" },
			// Unassigned replica: no store even with bytes=b.
			{ index: "good-large", shard: "0", prirep: "r", state: "UNASSIGNED", docs: "" },
			// Closed shard: same shape.
			{ index: "closed", shard: "0", prirep: "p", state: "UNASSIGNED", docs: "" },
		];
		const { handler } = makeHandler(rows);
		const result = await handler({ sortBy: "size" });
		const sorted = JSON.parse(result.content[2].text) as Array<{ index: string; store: string }>;
		// Only the two rows with store should appear, largest first.
		expect(sorted.map((s) => s.index)).toEqual(["good-large", "good-small"]);
		// Metadata text block should disclose the exclusion count.
		const metadataText = result.content[1].text;
		expect(metadataText).toMatch(/2 shards excluded from size sort/);
	});

	test("sortBy=size with all shards unassigned returns empty list + full exclusion count", async () => {
		const rows: CatRow[] = [
			{ index: "a", shard: "0", prirep: "r", state: "UNASSIGNED", docs: "" },
			{ index: "b", shard: "0", prirep: "r", state: "UNASSIGNED", docs: "" },
		];
		const { handler } = makeHandler(rows);
		const result = await handler({ sortBy: "size" });
		const sorted = JSON.parse(result.content[2].text) as unknown[];
		expect(sorted).toEqual([]);
		expect(result.content[1].text).toMatch(/2 shards excluded from size sort/);
	});
});

describe("get_shards sortBy=docs (regression, unchanged by SIO-660)", () => {
	test("sorts by docs desc as integer", async () => {
		const { handler } = makeHandler(sizeFixture);
		const result = await handler({ sortBy: "docs" });
		const shards = JSON.parse(result.content[2].text) as Array<{ docs: string }>;
		const counts = shards.map((s) => Number.parseInt(s.docs, 10));
		for (let i = 1; i < counts.length; i++) {
			expect(counts[i]).toBeLessThanOrEqual(counts[i - 1] ?? 0);
		}
	});
});


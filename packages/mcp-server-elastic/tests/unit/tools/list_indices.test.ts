// tests/unit/tools/list_indices.test.ts

import { beforeAll, describe, expect, test } from "bun:test";
import type { Client } from "@elastic/elasticsearch";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import { registerListIndicesTool } from "../../../src/tools/core/list_indices.js";
import { initializeReadOnlyManager } from "../../../src/utils/readOnlyMode.js";
import { getToolFromServer } from "../../utils/elasticsearch-client.js";

type CatRow = Record<string, string>;
type CatParams = { index?: string; format: "json"; h: string };
type ContentBlock = { type: string; text: string };
type ListIndicesResult = { content: ContentBlock[] };
type ListIndicesArgs = {
	indexPattern?: string;
	limit?: number;
	sortBy?: "name" | "size" | "docs" | "creation";
	sortOrder?: "asc" | "desc";
	includeSize?: boolean;
	excludeSystemIndices?: boolean;
	excludeDataStreams?: boolean;
};
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

// SIO-655 regression tests: limit honesty, sortOrder, loud-fail missing sort key,
// auto-include storeSize when sorting by size.
function makeStubClientWith(rows: CatRow[]): { client: Client; calls: { last?: CatParams } } {
	const calls: { last?: CatParams } = {};
	const client = {
		cat: {
			indices: async (params: CatParams) => {
				calls.last = params;
				return rows;
			},
		},
	} as unknown as Client;
	return { client, calls };
}

function makeHandlerWith(rows: CatRow[]): Handler {
	initializeReadOnlyManager(false, false);
	const server = new McpServer({ name: "test", version: "1.0.0" });
	const { client } = makeStubClientWith(rows);
	registerListIndicesTool(server, client);
	const tool = getToolFromServer(server, "elasticsearch_list_indices");
	if (!tool) throw new Error("tool not registered");
	return tool.handler as Handler;
}

function genRows(count: number): CatRow[] {
	return Array.from({ length: count }, (_, i) => ({
		index: `idx-${String(i).padStart(4, "0")}`,
		health: "green",
		status: "open",
		"docs.count": String(1000 - i),
		"store.size": "1.0mb",
		"store.size_in_bytes": String(1_000_000 - i),
		"creation.date.string": "2026-04-01T00:00:00Z",
	}));
}

function parseSummary(result: ListIndicesResult): Record<string, unknown> {
	// summary block is the second content entry (after header, before indices)
	return JSON.parse(result.content[1].text) as Record<string, unknown>;
}

describe("list_indices SIO-655: limit honesty", () => {
	test("limit=500 with 600 rows returns 500 and reports limit_applied=500, displayed=500", async () => {
		const handler = makeHandlerWith(genRows(600));
		const result = await handler({ limit: 500 });
		const summary = parseSummary(result);
		expect(summary.displayed).toBe(500);
		expect(summary.limit_applied).toBe(500);
		expect(summary.total_found).toBe(600);
	});

	test("limit=1000 with 120 rows returns 120; limit_applied reflects the effective cap (1000)", async () => {
		const handler = makeHandlerWith(genRows(120));
		const result = await handler({ limit: 1000 });
		const summary = parseSummary(result);
		expect(summary.displayed).toBe(120);
		expect(summary.limit_applied).toBe(1000);
	});

	test("limit=1500 rejected at Zod validation (schema max=1000)", async () => {
		const handler = makeHandlerWith(genRows(10));
		await expect(handler({ limit: 1500 })).rejects.toBeInstanceOf(McpError);
	});
});

describe("list_indices SIO-655: sortOrder and sort correctness", () => {
	test("sortBy=size, sortOrder=asc returns ascending monotonic bytes", async () => {
		const handler = makeHandlerWith(genRows(5));
		const result = await handler({ sortBy: "size", sortOrder: "asc" });
		const indices = JSON.parse(result.content[2].text) as Array<{ storeSize?: string }>;
		// Rows were generated with decreasing size_in_bytes, asc should reverse them
		const headerSummary = parseSummary(result);
		expect(headerSummary.sorted_by).toEqual({ key: "size", order: "asc" });
		expect(indices).toHaveLength(5);
		// Auto-include: storeSize should be present even though includeSize wasn't set
		expect(indices[0].storeSize).toBeDefined();
	});

	test("sortBy=docs, sortOrder=desc returns monotonic-decreasing docsCount", async () => {
		const handler = makeHandlerWith(genRows(10));
		const result = await handler({ sortBy: "docs", sortOrder: "desc" });
		const indices = JSON.parse(result.content[2].text) as Array<{ docsCount: string }>;
		const counts = indices.map((r) => Number.parseInt(r.docsCount, 10));
		for (let i = 1; i < counts.length; i++) {
			expect(counts[i]).toBeLessThanOrEqual(counts[i - 1]!);
		}
		expect(parseSummary(result).sorted_by).toEqual({ key: "docs", order: "desc" });
	});

	test("sortBy=name with no sortOrder defaults to ascending lexicographic", async () => {
		const rows: CatRow[] = [
			{ index: "zebra", health: "green", status: "open", "docs.count": "1" },
			{ index: "alpha", health: "green", status: "open", "docs.count": "2" },
			{ index: "mike", health: "green", status: "open", "docs.count": "3" },
		];
		const handler = makeHandlerWith(rows);
		const result = await handler({ sortBy: "name" });
		const indices = JSON.parse(result.content[2].text) as Array<{ index: string }>;
		expect(indices.map((r) => r.index)).toEqual(["alpha", "mike", "zebra"]);
		expect(parseSummary(result).sorted_by).toEqual({ key: "name", order: "asc" });
	});

	test("sortBy=size loud-fails when any row is missing store.size_in_bytes", async () => {
		const rows: CatRow[] = [
			{
				index: "good",
				health: "green",
				status: "open",
				"docs.count": "10",
				"store.size_in_bytes": "1000",
			},
			// Second row missing store.size_in_bytes — simulates closed/frozen index
			{ index: "bad", health: "green", status: "close", "docs.count": "0" },
		];
		const handler = makeHandlerWith(rows);
		await expect(handler({ sortBy: "size" })).rejects.toMatchObject({
			name: "McpError",
		});
	});

	test("no sortBy means sorted_by is null in metadata", async () => {
		const handler = makeHandlerWith(genRows(3));
		const result = await handler({});
		expect(parseSummary(result).sorted_by).toBeNull();
	});
});

describe("list_indices SIO-655: auto-include storeSize for sortBy=size", () => {
	test("sortBy=size without includeSize still returns storeSize in output rows", async () => {
		const handler = makeHandlerWith(genRows(3));
		const result = await handler({ sortBy: "size" });
		const indices = JSON.parse(result.content[2].text) as Array<{ storeSize?: string }>;
		expect(indices[0].storeSize).toBeDefined();
	});
});

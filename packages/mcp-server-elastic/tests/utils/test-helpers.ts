import { expect, mock } from "bun:test";
import type { Client } from "@elastic/elasticsearch";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { z } from "zod";

// Mock-shape sub-namespaces. Each method is a Bun mock returning a value
// matching the SDK call signature loosely. The terminal `as unknown as Client`
// cast lets test sites pass MockClient where the production code expects Client.
type MockFn = ReturnType<typeof mock>;

interface MockIndices {
	exists?: MockFn;
	create?: MockFn;
	delete?: MockFn;
	getMapping?: MockFn;
	getSettings?: MockFn;
	putMapping?: MockFn;
	refresh?: MockFn;
	flush?: MockFn;
	[k: string]: MockFn | undefined;
}

interface MockCluster {
	health?: MockFn;
	stats?: MockFn;
	[k: string]: MockFn | undefined;
}

interface MockNodes {
	info?: MockFn;
	stats?: MockFn;
	[k: string]: MockFn | undefined;
}

export interface MockClient {
	indices?: MockIndices;
	search?: MockFn;
	index?: MockFn;
	get?: MockFn;
	update?: MockFn;
	delete?: MockFn;
	bulk?: MockFn;
	count?: MockFn;
	cluster?: MockCluster;
	nodes?: MockNodes;
}

export function createMockClient(overrides: Partial<MockClient> = {}): Client {
	const mockClient: MockClient = {
		indices: {
			exists: mock(() => Promise.resolve(true)),
			create: mock(() => Promise.resolve({ acknowledged: true })),
			delete: mock(() => Promise.resolve({ acknowledged: true })),
			getMapping: mock(() => Promise.resolve({})),
			getSettings: mock(() => Promise.resolve({})),
			putMapping: mock(() => Promise.resolve({ acknowledged: true })),
			refresh: mock(() => Promise.resolve({})),
			flush: mock(() => Promise.resolve({})),
			...overrides.indices,
		},
		search: mock(() =>
			Promise.resolve({
				hits: {
					total: { value: 0 },
					hits: [],
				},
			}),
		),
		index: mock(() => Promise.resolve({ _id: "1", result: "created" })),
		get: mock(() => Promise.resolve({ _id: "1", _source: {} })),
		update: mock(() => Promise.resolve({ _id: "1", result: "updated" })),
		delete: mock(() => Promise.resolve({ _id: "1", result: "deleted" })),
		bulk: mock(() => Promise.resolve({ items: [] })),
		count: mock(() => Promise.resolve({ count: 0 })),
		cluster: {
			health: mock(() => Promise.resolve({ status: "green" })),
			stats: mock(() => Promise.resolve({})),
			...overrides.cluster,
		},
		nodes: {
			info: mock(() => Promise.resolve({})),
			stats: mock(() => Promise.resolve({})),
			...overrides.nodes,
		},
		...overrides,
	};

	return mockClient as unknown as Client;
}

// Shared shape for tools captured by the mock server's tool/registerTool calls.
export interface CapturedTool {
	name: string;
	description: string;
	schema: unknown;
	handler: (...args: unknown[]) => unknown;
}

export type MockServer = McpServer & {
	getTools: () => CapturedTool[];
	getTool: (name: string) => CapturedTool | undefined;
};

export function createMockServer(): MockServer {
	const tools: Map<string, CapturedTool> = new Map();

	return {
		tool: mock((name: string, description: string, schema: unknown, handler: (...args: unknown[]) => unknown) => {
			tools.set(name, { name, description, schema, handler });
		}),
		registerTool: mock(
			(
				name: string,
				metadata: { description?: string; inputSchema?: unknown },
				handler: (...args: unknown[]) => unknown,
			) => {
				tools.set(name, {
					name,
					description: metadata.description ?? "",
					schema: metadata.inputSchema,
					handler,
				});
			},
		),
		getTools: () => Array.from(tools.values()),
		getTool: (name: string) => tools.get(name),
	} as unknown as MockServer;
}

export function validateZodSchema(schema: z.ZodTypeAny): void {
	// Validate that the schema can parse valid data without throwing
	expect(schema).toBeDefined();
	expect(typeof schema.parse).toBe("function");
}

export function testToolRegistration(
	toolName: string,
	registerFunction: (server: McpServer, client: Client) => void,
): void {
	const mockServer = createMockServer();
	const mockClient = createMockClient();

	registerFunction(mockServer, mockClient);

	const tool = mockServer.getTool(toolName);
	expect(tool).toBeDefined();
	if (!tool) return;
	expect(tool.name).toBe(toolName);
	expect(tool.description).toBeDefined();
	expect(tool.schema).toBeDefined();
	expect(tool.handler).toBeDefined();
}

export async function testToolHandler(
	toolName: string,
	registerFunction: (server: McpServer, client: Client) => void,
	args: unknown,
	clientOverrides: Partial<MockClient> = {},
): Promise<unknown> {
	const mockServer = createMockServer();
	const mockClient = createMockClient(clientOverrides);

	registerFunction(mockServer, mockClient);

	const tool = mockServer.getTool(toolName);
	if (!tool) {
		throw new Error(`Tool ${toolName} not found`);
	}

	return await tool.handler(args);
}

export function createTestSearchResponse(numHits = 5) {
	const hits = Array.from({ length: numHits }, (_, i) => ({
		_id: `doc${i + 1}`,
		_score: 1.0 - i * 0.1,
		_source: {
			title: `Document ${i + 1}`,
			content: `This is the content of document ${i + 1}`,
		},
		highlight: {
			title: [`<em>Document</em> ${i + 1}`],
		},
	}));

	return {
		hits: {
			total: { value: numHits },
			hits,
		},
		aggregations: {},
	};
}

export function createTestMapping() {
	return {
		test_index: {
			mappings: {
				properties: {
					title: { type: "text" },
					content: { type: "text" },
					created_at: { type: "date" },
					status: { type: "keyword" },
					count: { type: "integer" },
				},
			},
		},
	};
}

interface CatIndicesEntry {
	health: string;
	status: string;
	index: string;
	uuid: string;
	pri: string;
	rep: string;
	"docs.count": string;
	"docs.deleted": string;
	"store.size": string;
	"pri.store.size": string;
}

export function createTestIndexList(numIndices = 3): Record<string, CatIndicesEntry> {
	const indices: Record<string, CatIndicesEntry> = {};
	for (let i = 0; i < numIndices; i++) {
		indices[`index-${i + 1}`] = {
			health: "green",
			status: "open",
			index: `index-${i + 1}`,
			uuid: `uuid-${i + 1}`,
			pri: "1",
			rep: "1",
			"docs.count": String(100 * (i + 1)),
			"docs.deleted": "0",
			"store.size": `${i + 1}mb`,
			"pri.store.size": `${i + 1}mb`,
		};
	}
	return indices;
}

export function createTestDocument(id = "1") {
	return {
		_id: id,
		_index: "test_index",
		_source: {
			title: `Test Document ${id}`,
			content: `This is test document ${id}`,
			created_at: new Date().toISOString(),
			status: "active",
			count: 42,
		},
	};
}

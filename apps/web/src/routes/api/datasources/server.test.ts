import { describe, expect, mock, test } from "bun:test";
import { EventEmitter } from "node:events";

// SIO-780: mock.module is process-global in bun; include every export touched by
// any sibling web test so the @devops-agent/agent module link succeeds regardless
// of test-file ordering (agent.test.ts mocks a different subset before us).
mock.module("@devops-agent/agent", () => ({
	AttachmentError: class AttachmentError extends Error {},
	buildGraph: () => Promise.resolve({}),
	buildIacGraph: () => Promise.resolve({}),
	createMcpClient: () => Promise.resolve(),
	flushLangSmithCallbacks: () => Promise.resolve(),
	getAgent: () => ({ manifest: {}, tools: [], subAgents: new Map(), knowledge: [] }),
	getAgentByName: () => ({ manifest: {}, tools: [], subAgents: new Map(), knowledge: [] }),
	getConnectedServers: () => ["elastic-mcp", "kafka-mcp"],
	getServerStates: () => ({
		"elastic-mcp": "ready",
		"kafka-mcp": "unready",
		"konnect-mcp": "down",
	}),
	processAttachments: () => Promise.resolve({ contentBlocks: [], metadata: [], warnings: [] }),
	// SIO-906: events route test imports mcpEvents from this specifier; include it so
	// the shared process-global mock stays link-compatible across files.
	mcpEvents: new EventEmitter(),
}));
// SIO-780: sibling tests register additional exports on $lib/server/agent; mirror
// them here so the global mock cache stays link-compatible across files.
mock.module("$lib/server/agent", () => ({
	ensureMcpConnected: async () => {},
	invokeAgent: async () => ({ async *[Symbol.asyncIterator]() {} }),
	resumeAgent: async () => ({ async *[Symbol.asyncIterator]() {} }),
	getPendingInterrupt: async () => undefined,
}));

const { GET } = await import("./+server.ts");

describe("GET /api/datasources", () => {
	test("returns dataSources, connected, and states", async () => {
		process.env.ELASTIC_MCP_URL = "http://localhost:9080";
		process.env.KAFKA_MCP_URL = "http://localhost:9081";
		process.env.KONNECT_MCP_URL = "http://localhost:9083";

		const res = await GET({} as never);
		const body = await res.json();

		expect(body.dataSources).toEqual(expect.arrayContaining(["elastic", "kafka", "konnect"]));
		expect(body.connected).toEqual(expect.arrayContaining(["elastic", "kafka"]));
		expect(body.states).toEqual({
			elastic: "ready",
			kafka: "unready",
			konnect: "down",
		});
	});
});

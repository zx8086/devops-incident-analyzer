import { describe, expect, mock, test } from "bun:test";
import { EventEmitter } from "node:events";

// SIO-780: mock.module is process-global in bun; include every export touched by
// any sibling web test so the @devops-agent/agent module link succeeds regardless
// of test-file ordering (agent.test.ts mocks a different subset before us).
mock.module("@devops-agent/agent", () => ({
	AttachmentError: class AttachmentError extends Error {},
	// SIO-1110: $lib/server/agent.ts imports GRAPH_DEADLINE_KEY at module scope.
	GRAPH_DEADLINE_KEY: "graphDeadlineAt",
	buildGraph: () => Promise.resolve({}),
	buildIacGraph: () => Promise.resolve({}),
	createMcpClient: () => Promise.resolve(),
	stopHealthPolling: () => undefined,
	flushLangSmithCallbacks: () => Promise.resolve(),
	getAgent: () => ({ manifest: {}, tools: [], subAgents: new Map(), knowledge: [] }),
	getAgentByName: () => ({ manifest: {}, tools: [], subAgents: new Map(), knowledge: [] }),
	// SIO-930: $lib/server/agent.ts imports iacTurnOutcome from this module; the mock must export it
	// (process-global mock cache must stay link-compatible across sibling files).
	iacTurnOutcome: () => "completed",
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
	// SIO-1045: agent.ts (real module, loaded when agent.test.ts runs) imports these at
	// module scope; iac-reconcile-cron.ts (imported transitively by agent.ts) imports
	// reconcileAll/selectedBackend. The memory/promote and actions routes import
	// promoteToMemory/executeAction/getAvailableActionTools from this same specifier.
	appliedSkillsForNames: () => [] as unknown[],
	installSkillLearner: () => undefined,
	promoteToMemory: () => Promise.resolve(),
	executeAction: () => Promise.resolve(),
	getAvailableActionTools: () => [] as unknown[],
	reconcileAll: () => Promise.resolve({ reconciled: 0, skipped: 0, errors: 0 }),
	// SIO-1104 (5a): kg-topology-cron.ts imports these transitively via agent.ts.
	runTopologySweep: () => Promise.resolve({ sources: {} }),
	topologyCronEnabled: () => false,
	selectedBackend: () => "file" as const,
}));
// SIO-780: sibling tests register additional exports on $lib/server/agent; mirror
// them here so the global mock cache stays link-compatible across files.
mock.module("$lib/server/agent", () => ({
	ensureMcpConnected: async () => {},
	invokeAgent: async () => ({ async *[Symbol.asyncIterator]() {} }),
	resumeAgent: async () => ({ async *[Symbol.asyncIterator]() {} }),
	getPendingInterrupt: async () => undefined,
	// SIO-930: keep the process-global mock link-compatible with the stream route test.
	getIacTurnOutcome: async () => "completed",
	// SIO-1045: union of every sibling route test's $lib/server/agent imports, so the
	// process-global mock cache stays link-compatible regardless of file ordering.
	getLastAssistantText: async () => "",
	pruneThreadState: async () => {},
	runPostTurn: async () => {},
	setSessionOutcome: () => undefined,
	incrementSseConnections: () => undefined,
	decrementSseConnections: () => undefined,
	getActiveSseConnections: () => 0,
	getAgentRuntimeStatus: () => ({
		graphReady: false,
		iacGraphReady: false,
		mcpInitialized: false,
		checkpointerType: "memory" as const,
	}),
	sessionTeardown: async () => {},
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

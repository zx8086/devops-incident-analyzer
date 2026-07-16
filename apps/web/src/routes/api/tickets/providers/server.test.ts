import { describe, expect, mock, test } from "bun:test";
import { EventEmitter } from "node:events";

let availableProviders: unknown[] = [];

// SIO-780/SIO-1045: mock.module is process-global in bun; include every export
// touched by any sibling web test so the @devops-agent/agent module link
// succeeds regardless of test-file ordering.
mock.module("@devops-agent/agent", () => ({
	AttachmentError: class AttachmentError extends Error {},
	GRAPH_DEADLINE_KEY: "graphDeadlineAt",
	buildGraph: () => Promise.resolve({}),
	buildIacGraph: () => Promise.resolve({}),
	createMcpClient: () => Promise.resolve(),
	stopHealthPolling: () => undefined,
	flushLangSmithCallbacks: () => Promise.resolve(),
	getAgent: () => ({ manifest: {}, tools: [], subAgents: new Map(), knowledge: [] }),
	getAgentByName: () => ({ manifest: {}, tools: [], subAgents: new Map(), knowledge: [] }),
	iacTurnOutcome: () => "completed",
	getConnectedServers: () => [] as string[],
	getServerStates: () => ({}),
	processAttachments: () => Promise.resolve({ contentBlocks: [], metadata: [], warnings: [] }),
	mcpEvents: new EventEmitter(),
	appliedSkillsForNames: () => [] as unknown[],
	installSkillLearner: () => undefined,
	promoteToMemory: () => Promise.resolve(),
	executeAction: () => Promise.resolve(),
	getAvailableActionTools: () => [] as unknown[],
	reconcileAll: () => Promise.resolve({ reconciled: 0, skipped: 0, errors: 0 }),
	reconcileEnabled: () => false,
	runTopologySweep: () => Promise.resolve({ sources: {} }),
	topologyCronEnabled: () => false,
	selectedBackend: () => "file" as const,
	// SIO-1124: the /api/tickets routes import these from this same specifier.
	getTicketProvider: () => undefined,
	listAvailableTicketProviders: () => availableProviders,
}));
mock.module("$lib/server/agent", () => ({
	ensureMcpConnected: async () => {},
	invokeAgent: async () => ({ async *[Symbol.asyncIterator]() {} }),
	resumeAgent: async () => ({ async *[Symbol.asyncIterator]() {} }),
	getPendingInterrupt: async () => undefined,
	getIacTurnOutcome: async () => "completed",
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

describe("GET /api/tickets/providers", () => {
	test("returns the available providers", async () => {
		availableProviders = [{ id: "jira", label: "Jira" }];
		const res = await GET({} as never);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ providers: [{ id: "jira", label: "Jira" }] });
	});

	test("returns an empty list when no provider is available", async () => {
		availableProviders = [];
		const res = await GET({} as never);
		expect(await res.json()).toEqual({ providers: [] });
	});
});

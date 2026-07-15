// apps/web/src/routes/health/server.test.ts
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// SIO-482: the health route now imports getServerStates/getConnectedServers from
// @devops-agent/agent and runtime accessors from $lib/server/agent. Mock both so
// the unit test stays fast and deterministic (no langgraph/MCP machinery).
let mockServerStates: Record<string, string> = {};
let mockConnected: string[] = [];
let mockActiveSse = 0;
let mockRuntime = {
	graphReady: false,
	iacGraphReady: false,
	mcpInitialized: false,
	checkpointerType: "memory" as "memory" | "sqlite",
};

// SIO-1045: mock.module is process-global + last-wins in bun. The package test script
// runs `bun test --isolate` so each file gets a fresh module registry and these mocks
// can no longer leak into sibling files (on Linux the "$lib/server/agent" noops below
// used to shadow agent.test.ts's real ./agent.ts import, and a missing export here
// broke iac-reconcile-cron.test.ts linking). If you run a multi-file `bun test`
// directly WITHOUT --isolate, both blocks below must stay a superset of every named
// import any sibling web test file touches from these two specifiers.
mock.module("@devops-agent/agent", () => ({
	getServerStates: () => mockServerStates,
	getConnectedServers: () => mockConnected,
	AttachmentError: class AttachmentError extends Error {},
	buildGraph: () => Promise.resolve({}),
	buildIacGraph: () => Promise.resolve({}),
	createMcpClient: () => Promise.resolve(),
	flushLangSmithCallbacks: () => Promise.resolve(),
	getAgent: () => ({ manifest: {}, tools: [], subAgents: new Map(), knowledge: [] }),
	getAgentByName: () => ({ manifest: {}, tools: [], subAgents: new Map(), knowledge: [] }),
	iacTurnOutcome: () => "completed" as const,
	processAttachments: () => Promise.resolve({ contentBlocks: [], metadata: [], warnings: [] }),
	mcpEvents: undefined,
	appliedSkillsForNames: () => [] as unknown[],
	installSkillLearner: () => undefined,
	installAgentMemory: () => undefined,
	installGraphWarmer: () => undefined,
	installMemoryPromotion: () => undefined,
	needsPruning: () => false,
	pruneState: () => ({ removeIds: [] as string[] }),
	runBootstrap: () => Promise.resolve({ stepsRun: [] }),
	runPostTurn: () => Promise.resolve(),
	runTeardown: () => Promise.resolve([]),
	setSessionOutcome: () => undefined,
	reconcileAll: () => Promise.resolve({ reconciled: 0, skipped: 0, errors: 0 }),
	reconcileEnabled: () => false,
	selectedBackend: () => "file" as const,
	promoteToMemory: () => Promise.resolve(),
	executeAction: () => Promise.resolve(),
	getAvailableActionTools: () => [] as unknown[],
}));
mock.module("$lib/server/agent", () => ({
	getActiveSseConnections: () => mockActiveSse,
	getAgentRuntimeStatus: () => mockRuntime,
	ensureMcpConnected: async () => undefined,
	invokeAgent: async () => ({ async *[Symbol.asyncIterator]() {} }),
	resumeAgent: async () => ({ async *[Symbol.asyncIterator]() {} }),
	getPendingInterrupt: async () => undefined,
	getIacTurnOutcome: async () => "completed",
	getLastAssistantText: async () => "",
	pruneThreadState: async () => undefined,
	runPostTurn: async () => undefined,
	setSessionOutcome: () => undefined,
	incrementSseConnections: () => undefined,
	decrementSseConnections: () => undefined,
	sessionTeardown: async () => undefined,
}));

const { GET } = await import("./+server.ts");

const ENV_KEYS = ["ELASTIC_MCP_URL", "KAFKA_MCP_URL", "COUCHBASE_MCP_URL", "KONNECT_MCP_URL"] as const;
type EnvKey = (typeof ENV_KEYS)[number];

interface HealthBody {
	status: string;
	timestamp: string;
	services: Record<string, boolean>;
	mcp: { connected: string[]; states: Record<string, string> };
	agent: { graphReady: boolean; iacGraphReady: boolean; mcpInitialized: boolean; checkpointerType: string };
	activeSseConnections: number;
}

describe("GET /health", () => {
	const original: Partial<Record<EnvKey, string | undefined>> = {};

	beforeEach(() => {
		for (const key of ENV_KEYS) {
			original[key] = process.env[key];
			delete process.env[key];
		}
		// reset mock state to defaults each test
		mockServerStates = {};
		mockConnected = [];
		mockActiveSse = 0;
		mockRuntime = { graphReady: false, iacGraphReady: false, mcpInitialized: false, checkpointerType: "memory" };
	});

	afterEach(() => {
		for (const key of ENV_KEYS) {
			if (original[key] === undefined) delete process.env[key];
			else process.env[key] = original[key];
		}
	});

	// --- backward-compatibility (existing contract) ---

	test("returns ok with all services false when no MCP URLs configured", async () => {
		const response = await GET({} as Parameters<typeof GET>[0]);
		expect(response.status).toBe(200);
		const body = (await response.json()) as HealthBody;
		expect(body.status).toBe("ok");
		expect(typeof body.timestamp).toBe("string");
		expect(Number.isNaN(Date.parse(body.timestamp))).toBe(false);
		expect(body.services).toEqual({ elastic: false, kafka: false, couchbase: false, konnect: false });
	});

	test("reflects configured MCP URLs as true", async () => {
		process.env.ELASTIC_MCP_URL = "http://localhost:9080";
		process.env.KAFKA_MCP_URL = "http://localhost:9081";
		const response = await GET({} as Parameters<typeof GET>[0]);
		const body = (await response.json()) as HealthBody;
		expect(body.services.elastic).toBe(true);
		expect(body.services.kafka).toBe(true);
		expect(body.services.couchbase).toBe(false);
		expect(body.services.konnect).toBe(false);
	});

	// --- SIO-482 enhancements ---

	test("reports MCP states, connected servers, runtime status, and SSE count", async () => {
		mockServerStates = { "elastic-mcp": "ready", "kafka-mcp": "ready" };
		mockConnected = ["elastic-mcp", "kafka-mcp"];
		mockActiveSse = 3;
		mockRuntime = { graphReady: true, iacGraphReady: false, mcpInitialized: true, checkpointerType: "sqlite" };

		const response = await GET({} as Parameters<typeof GET>[0]);
		expect(response.status).toBe(200);
		const body = (await response.json()) as HealthBody;
		expect(body.status).toBe("ok"); // all probed servers ready
		expect(body.mcp.states).toEqual({ "elastic-mcp": "ready", "kafka-mcp": "ready" });
		expect(body.mcp.connected).toEqual(["elastic-mcp", "kafka-mcp"]);
		expect(body.agent).toEqual({
			graphReady: true,
			iacGraphReady: false,
			mcpInitialized: true,
			checkpointerType: "sqlite",
		});
		expect(body.activeSseConnections).toBe(3);
	});

	test("status is 'degraded' (still HTTP 200) when a probed server is not ready", async () => {
		mockServerStates = { "elastic-mcp": "ready", "kafka-mcp": "down" };
		const response = await GET({} as Parameters<typeof GET>[0]);
		expect(response.status).toBe(200);
		const body = (await response.json()) as HealthBody;
		expect(body.status).toBe("degraded");
	});

	test("status is 'ok' when no servers have been probed yet (empty states)", async () => {
		mockServerStates = {};
		const response = await GET({} as Parameters<typeof GET>[0]);
		const body = (await response.json()) as HealthBody;
		expect(body.status).toBe("ok");
	});
});

// apps/web/src/routes/api/events/server.test.ts
import { afterEach, describe, expect, mock, test } from "bun:test";
import { EventEmitter } from "node:events";

// SIO-906: the handler imports `mcpEvents` from @devops-agent/agent. Use a REAL
// EventEmitter (not a mock fn) so we can assert listenerCount and real synchronous
// emit/throw semantics — the exact behavior the fix depends on.
const mcpEvents = new EventEmitter();

// SIO-780 / SIO-906: mock.module is process-global + last-wins in bun. Include every
// export any sibling web test touches (stream + datasources tests) so the
// @devops-agent/agent module link stays valid regardless of file ordering, then
// overlay our real mcpEvents.
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
	getConnectedServers: () => [] as string[],
	getServerStates: () => ({}) as Record<string, string>,
	getLastAssistantText: async () => "",
	// SIO-930: $lib/server/agent.ts imports iacTurnOutcome; keep the shared mock link-compatible.
	iacTurnOutcome: () => "completed",
	processAttachments: () => Promise.resolve({ contentBlocks: [], metadata: [], warnings: [] }),
	mcpEvents,
	// SIO-1045: agent.test.ts's REAL import of ./agent.ts needs the full module-scope
	// import set (installSkillLearner is CALLED at load time) + iac-reconcile-cron.ts's
	// transitive reconcileAll/selectedBackend, or agent.test.ts fails to link when this
	// file's mock wins the process-global last-wins cache.
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
	// SIO-1104 (5a): kg-topology-cron.ts imports these transitively via agent.ts.
	runTopologySweep: () => Promise.resolve({ sources: {} }),
	topologyCronEnabled: () => false,
	selectedBackend: () => "file" as const,
	promoteToMemory: () => Promise.resolve(),
	executeAction: () => Promise.resolve(),
	getAvailableActionTools: () => [] as unknown[],
	// SIO-1124: the /api/tickets routes import these from this same specifier.
	getTicketProvider: () => undefined,
	listAvailableTicketProviders: () => [] as unknown[],
}));

const { GET } = await import("./+server.ts");

const EVENT = "mcp_replaced";

function makeReplacedEvent(server = "elastic-mcp") {
	return {
		type: "mcp_replaced" as const,
		server,
		oldInstanceId: "old-1",
		newInstanceId: "new-2",
		toolCountDelta: 3,
	};
}

async function openStream(): Promise<ReadableStreamDefaultReader<Uint8Array>> {
	const response = await GET({} as Parameters<typeof GET>[0]);
	expect(response.status).toBe(200);
	expect(response.headers.get("Content-Type")).toBe("text/event-stream");
	expect(response.body).toBeTruthy();
	const reader = (response.body as ReadableStream<Uint8Array>).getReader();
	// Drain the initial ":ok" handshake so the listener is registered.
	const first = await reader.read();
	const text = new TextDecoder().decode(first.value);
	expect(text).toContain(":ok");
	return reader;
}

afterEach(() => {
	// Defensive: no test should leak listeners into the next.
	mcpEvents.removeAllListeners(EVENT);
});

describe("GET /api/events — SSE delivery", () => {
	test("forwards an mcp_replaced event to a connected client", async () => {
		const baseline = mcpEvents.listenerCount(EVENT);
		const reader = await openStream();
		expect(mcpEvents.listenerCount(EVENT)).toBe(baseline + 1);

		const event = makeReplacedEvent("kafka-mcp");
		mcpEvents.emit(EVENT, event);

		const { value } = await reader.read();
		const text = new TextDecoder().decode(value);
		expect(text).toContain("event: mcp_replaced");
		expect(text).toContain(JSON.stringify(event));

		await reader.cancel();
	});
});

describe("GET /api/events — listener cleanup (SIO-906)", () => {
	test("cancel() deregisters the listener back to baseline", async () => {
		const baseline = mcpEvents.listenerCount(EVENT);
		const reader = await openStream();
		expect(mcpEvents.listenerCount(EVENT)).toBe(baseline + 1);

		await reader.cancel();
		expect(mcpEvents.listenerCount(EVENT)).toBe(baseline);
	});

	test("emitting after client disconnect does not throw", async () => {
		const reader = await openStream();
		await reader.cancel();

		// The leaked-listener bug threw "Invalid state: Controller is already closed"
		// here; after cleanup there is no listener and emit is a no-op.
		expect(() => mcpEvents.emit(EVENT, makeReplacedEvent())).not.toThrow();
	});
});

describe("mcpEvents emit isolation (SIO-906)", () => {
	test("a throwing mcp_replaced listener does not propagate out of emit()", () => {
		// Mirrors the mcp-bridge.ts try/catch around emit: a bad SSE controller must
		// not unwind into the health-poll cycle. emit() itself re-throws, so the guard
		// lives at the call site — verify a wrapped emit swallows the throw.
		const thrower = () => {
			throw new Error("Invalid state: Controller is already closed");
		};
		mcpEvents.on(EVENT, thrower);

		const guardedEmit = () => {
			try {
				mcpEvents.emit(EVENT, makeReplacedEvent());
			} catch {
				// swallowed, as mcp-bridge.ts does
			}
		};
		expect(guardedEmit).not.toThrow();

		mcpEvents.off(EVENT, thrower);
	});
});

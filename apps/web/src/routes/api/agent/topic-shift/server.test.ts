// apps/web/src/routes/api/agent/topic-shift/+server.test.ts
import { describe, expect, mock, test } from "bun:test";
import { EventEmitter } from "node:events";

mock.module("@devops-agent/agent", () => ({
	flushLangSmithCallbacks: mock(() => Promise.resolve()),
	// SIO-780: datasources route test runs later in the same process and imports
	// these from the same module specifier; include them so the cached namespace
	// has the symbols regardless of file ordering.
	getConnectedServers: mock(() => [] as string[]),
	getServerStates: mock(() => ({}) as Record<string, string>),
	getAgentByName: () => ({ manifest: {}, tools: [], subAgents: new Map(), knowledge: [] }),
	buildIacGraph: () => Promise.resolve({}),
	// SIO-906: events route test imports mcpEvents from this specifier; include it so
	// the shared process-global mock stays link-compatible across files.
	mcpEvents: new EventEmitter(),
	// SIO-1045: agent.test.ts's REAL import of ./agent.ts needs the full module-scope
	// import set (installSkillLearner is CALLED at load time) + iac-reconcile-cron.ts's
	// transitive reconcileAll/selectedBackend, or agent.test.ts fails to link when this
	// file's mock wins the process-global last-wins cache.
	AttachmentError: class AttachmentError extends Error {},
	// SIO-1110: $lib/server/agent.ts imports GRAPH_DEADLINE_KEY at module scope.
	GRAPH_DEADLINE_KEY: "graphDeadlineAt",
	buildGraph: mock(() => Promise.resolve({})),
	createMcpClient: mock(() => Promise.resolve()),
	stopHealthPolling: mock(() => undefined),
	getAgent: () => ({ manifest: {}, tools: [], subAgents: new Map(), knowledge: [] }),
	iacTurnOutcome: mock(() => "completed" as const),
	processAttachments: mock(() => Promise.resolve({ contentBlocks: [], metadata: [], warnings: [] })),
	appliedSkillsForNames: mock(() => [] as unknown[]),
	installSkillLearner: mock(() => undefined),
	installAgentMemory: mock(() => undefined),
	installGraphWarmer: mock(() => undefined),
	installMemoryPromotion: mock(() => undefined),
	needsPruning: () => false,
	pruneState: () => ({ removeIds: [] as string[] }),
	runBootstrap: mock(() => Promise.resolve({ stepsRun: [] })),
	runPostTurn: mock(() => Promise.resolve()),
	runTeardown: mock(() => Promise.resolve([])),
	setSessionOutcome: mock(() => undefined),
	reconcileAll: mock(() => Promise.resolve({ reconciled: 0, skipped: 0, errors: 0 })),
	reconcileEnabled: mock(() => false),
	// SIO-1104 (5a): kg-topology-cron.ts is imported transitively via agent.ts the same way --
	// the stub must export its imports too. topologyCronEnabled() false keeps the cron unregistered.
	runTopologySweep: mock(() => Promise.resolve({ sources: {} })),
	topologyCronEnabled: mock(() => false),
	selectedBackend: mock(() => "file" as const),
	promoteToMemory: mock(() => Promise.resolve()),
	executeAction: mock(() => Promise.resolve()),
	getAvailableActionTools: mock(() => [] as unknown[]),
}));

const sharedLogger = {
	info: mock(() => undefined),
	error: mock(() => undefined),
	warn: mock(() => undefined),
	debug: mock(() => undefined),
};
const runWithRequestContextMock = mock(async (_ctx: unknown, fn: () => Promise<unknown>) => fn());
mock.module("@devops-agent/observability", () => ({
	traceSpan: mock(async (_name: string, _op: string, fn: () => Promise<unknown>) => fn()),
	getLogger: mock(() => sharedLogger),
	runWithRequestContext: runWithRequestContextMock,
}));

const buildLangSmithTagsMock = mock(() => ["chat", "resumed"] as string[]);
mock.module("$lib/server/langsmith-tags", () => ({
	buildLangSmithTags: buildLangSmithTagsMock,
}));

const resumeAgentMock = mock(
	async (): Promise<AsyncIterable<Record<string, unknown>>> => ({
		async *[Symbol.asyncIterator]() {
			// no events
		},
	}),
);

mock.module("$lib/server/agent", () => ({
	resumeAgent: resumeAgentMock,
	getPendingInterrupt: mock(async () => undefined),
	pruneThreadState: mock(() => Promise.resolve()),
	// SIO-942: topic-shift/+server.ts calls this after the resumed turn (live-memory flush).
	// Also keeps the process-global mock link-compatible with the stream route test.
	runPostTurn: mock(() => Promise.resolve()),
	// SIO-952: iac/resume route stamps the turn outcome; keep the process-global mock
	// link-compatible across route tests (last-wins cache).
	setSessionOutcome: mock(() => undefined),
	// SIO-930: keep the process-global $lib/server/agent mock link-compatible with the stream
	// route test (last-wins mock cache); stream/+server.ts imports getIacTurnOutcome.
	getIacTurnOutcome: mock(async () => "completed"),
	// SIO-1045: union of every sibling route test's $lib/server/agent imports, so the
	// process-global mock cache stays link-compatible regardless of file ordering.
	invokeAgent: mock(async () => ({ async *[Symbol.asyncIterator]() {} })),
	ensureMcpConnected: mock(async () => undefined),
	getLastAssistantText: mock(async () => ""),
	incrementSseConnections: mock(() => undefined),
	decrementSseConnections: mock(() => undefined),
	sessionTeardown: mock(async () => undefined),
	getActiveSseConnections: mock(() => 0),
	getAgentRuntimeStatus: mock(() => ({
		graphReady: false,
		iacGraphReady: false,
		mcpInitialized: false,
		checkpointerType: "memory" as const,
	})),
}));

mock.module("$lib/server/sse-pump", () => ({
	pumpEventStream: mock(async (events: AsyncIterable<Record<string, unknown>>, _send: unknown) => {
		for await (const _ of events) {
			// drain
		}
		return { toolsUsed: [] as string[] };
	}),
	emitTopicShiftPrompt: mock(() => false),
}));

const { POST } = await import("./+server.ts");

function makeRequest(body: unknown): Parameters<typeof POST>[0] {
	const request = new Request("http://localhost/api/agent/topic-shift", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	return { request } as Parameters<typeof POST>[0];
}

async function collectSse(response: Response): Promise<Record<string, unknown>[]> {
	expect(response.body).toBeTruthy();
	if (!response.body) return [];
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	const events: Record<string, unknown>[] = [];
	let buffer = "";
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		buffer += decoder.decode(value, { stream: true });
		const lines = buffer.split("\n");
		buffer = lines.pop() ?? "";
		for (const line of lines) {
			if (!line.startsWith("data: ")) continue;
			events.push(JSON.parse(line.slice(6)));
		}
	}
	return events;
}

describe("POST /api/agent/topic-shift — validation", () => {
	test("returns 400 for missing threadId", async () => {
		const response = await POST(makeRequest({ decision: "continue" }));
		expect(response.status).toBe(400);
	});

	test("returns 400 for invalid decision enum", async () => {
		const response = await POST(makeRequest({ threadId: "t-1", decision: "maybe" }));
		expect(response.status).toBe(400);
	});
});

describe("POST /api/agent/topic-shift — lifecycle logging", () => {
	test("emits agent.request.resume.start with correlation envelope", async () => {
		sharedLogger.info.mockClear();
		runWithRequestContextMock.mockClear();

		const response = await POST(makeRequest({ threadId: "t-1", decision: "continue" }));
		await collectSse(response);

		const calls = sharedLogger.info.mock.calls as unknown as unknown[][];
		const startCall = calls.find(
			(c) => c[c.length - 1] === "agent.request.resume.start" || c[0] === "agent.request.resume.start",
		);
		expect(startCall).toBeDefined();

		expect(runWithRequestContextMock).toHaveBeenCalled();
		const ctxCalls = runWithRequestContextMock.mock.calls as unknown as unknown[][];
		const ctx = ctxCalls[0]?.[0] as { threadId: string; runId: string; requestId: string };
		expect(ctx.threadId).toBe("t-1");
		expect(typeof ctx.runId).toBe("string");
		expect(typeof ctx.requestId).toBe("string");
	});

	test("emits agent.request.resume.end after happy path", async () => {
		sharedLogger.info.mockClear();

		const response = await POST(makeRequest({ threadId: "t-1", decision: "continue" }));
		await collectSse(response);

		const calls = sharedLogger.info.mock.calls as unknown as unknown[][];
		const endCall = calls.find(
			(c) => c[c.length - 1] === "agent.request.resume.end" || c[0] === "agent.request.resume.end",
		);
		expect(endCall).toBeDefined();
		const meta = endCall?.[0] as { responseTime?: number };
		expect(typeof meta.responseTime).toBe("number");
	});

	test("emits agent.request.resume.error when resumeAgent throws", async () => {
		sharedLogger.error.mockClear();
		resumeAgentMock.mockImplementationOnce(async () => {
			throw new Error("resume-boom");
		});

		const response = await POST(makeRequest({ threadId: "t-1", decision: "continue" }));
		await collectSse(response);

		const calls = sharedLogger.error.mock.calls as unknown as unknown[][];
		const errCall = calls.find(
			(c) => c[c.length - 1] === "agent.request.resume.error" || c[0] === "agent.request.resume.error",
		);
		expect(errCall).toBeDefined();
		const meta = errCall?.[0] as { err?: { message?: string } };
		expect(meta.err?.message).toBe("resume-boom");
	});

	test("resumeAgent receives runName + resumed tags", async () => {
		resumeAgentMock.mockClear();
		buildLangSmithTagsMock.mockClear();
		buildLangSmithTagsMock.mockImplementationOnce(() => ["chat", "thread:t-1", "resumed"] as string[]);

		const response = await POST(makeRequest({ threadId: "t-1", decision: "continue" }));
		await collectSse(response);

		expect(resumeAgentMock).toHaveBeenCalled();
		const callArgs = resumeAgentMock.mock.calls as unknown as unknown[][];
		const args = callArgs[0]?.[0] as { runName?: string; tags?: string[] };
		expect(args.runName).toBe("agent.request");
		expect(args.tags).toContain("chat");
		expect(args.tags).toContain("resumed");

		expect(buildLangSmithTagsMock).toHaveBeenCalledWith({
			threadId: "t-1",
			resumed: true,
		});
	});
});

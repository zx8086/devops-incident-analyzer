// apps/web/src/routes/api/agent/learning/resume/server.test.ts
// SIO-1126: resume endpoint for the HIL learning gates (match + review).
import { describe, expect, mock, test } from "bun:test";
import { EventEmitter } from "node:events";

mock.module("@devops-agent/agent", () => ({
	flushLangSmithCallbacks: mock(() => Promise.resolve()),
	// Link-compatibility union with the sibling route tests (process-global
	// last-wins mock cache; see topic-shift/server.test.ts SIO-1045 note).
	getConnectedServers: mock(() => [] as string[]),
	getServerStates: mock(() => ({}) as Record<string, string>),
	getAgentByName: () => ({ manifest: {}, tools: [], subAgents: new Map(), knowledge: [] }),
	buildIacGraph: () => Promise.resolve({}),
	mcpEvents: new EventEmitter(),
	AttachmentError: class AttachmentError extends Error {},
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
mock.module("@devops-agent/observability", () => ({
	traceSpan: mock(async (_name: string, _op: string, fn: () => Promise<unknown>) => fn()),
	getLogger: mock(() => sharedLogger),
	runWithRequestContext: mock(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
}));

mock.module("$lib/server/langsmith-tags", () => ({
	buildLangSmithTags: mock(() => ["chat", "resumed"] as string[]),
}));

const resumeAgentMock = mock(
	async (): Promise<AsyncIterable<Record<string, unknown>>> => ({
		async *[Symbol.asyncIterator]() {
			// no events
		},
	}),
);
const getPendingInterruptMock = mock(async (): Promise<{ value: unknown } | undefined> => undefined);
const getLastAssistantTextMock = mock(async () => "Learned from DEVOPS-1355.");

mock.module("$lib/server/agent", () => ({
	resumeAgent: resumeAgentMock,
	getPendingInterrupt: getPendingInterruptMock,
	getLastAssistantText: getLastAssistantTextMock,
	pruneThreadState: mock(() => Promise.resolve()),
	runPostTurn: mock(() => Promise.resolve()),
	setSessionOutcome: mock(() => undefined),
	getIacTurnOutcome: mock(async () => "completed"),
	invokeAgent: mock(async () => ({ async *[Symbol.asyncIterator]() {} })),
	ensureMcpConnected: mock(async () => undefined),
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

const emitHilLearningInterruptMock = mock(() => false);
mock.module("$lib/server/sse-pump", () => ({
	pumpEventStream: mock(async (events: AsyncIterable<Record<string, unknown>>) => {
		for await (const _ of events) {
			// drain
		}
		return { toolsUsed: [] as string[], responseContent: "", hilLearningTurn: true };
	}),
	emitHilLearningInterrupt: emitHilLearningInterruptMock,
	emitTopicShiftPrompt: mock(() => false),
	emitIacInterrupt: mock(() => false),
}));

const { POST } = await import("./+server.ts");

function makeRequest(body: unknown): Parameters<typeof POST>[0] {
	const request = new Request("http://localhost/api/agent/learning/resume", {
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

describe("POST /api/agent/learning/resume — validation", () => {
	test("400 for missing threadId", async () => {
		const response = await POST(makeRequest({ match: { incidentId: "inc-1" } }));
		expect(response.status).toBe(400);
	});

	test("400 when neither match nor review is provided", async () => {
		const response = await POST(makeRequest({ threadId: "t-1" }));
		expect(response.status).toBe(400);
	});

	test("400 when both match and review are provided (mixed payload)", async () => {
		const response = await POST(
			makeRequest({ threadId: "t-1", match: { incidentId: "inc-1" }, review: { decisions: {} } }),
		);
		expect(response.status).toBe(400);
	});

	test("400 for an invalid decision value", async () => {
		const response = await POST(makeRequest({ threadId: "t-1", review: { decisions: { "rc-1": "maybe" } } }));
		expect(response.status).toBe(400);
	});
});

describe("POST /api/agent/learning/resume — happy path", () => {
	test("match resume: clears the card, forwards incidentId, emits final message + done", async () => {
		resumeAgentMock.mockClear();
		getPendingInterruptMock.mockImplementation(async () => undefined);

		const response = await POST(makeRequest({ threadId: "t-1", match: { incidentId: "inc-1" } }));
		const events = await collectSse(response);

		expect(events[0]?.type).toBe("hil_learning_resolved");
		expect(events.some((e) => e.type === "message" && e.content === "Learned from DEVOPS-1355.")).toBe(true);
		expect(events.at(-1)?.type).toBe("done");

		const callArgs = resumeAgentMock.mock.calls as unknown as unknown[][];
		const args = callArgs[0]?.[0] as { resumeValue?: { incidentId?: string | null } };
		expect(args.resumeValue).toEqual({ incidentId: "inc-1" });
	});

	test("null incidentId (none of these) is forwarded verbatim", async () => {
		resumeAgentMock.mockClear();
		const response = await POST(makeRequest({ threadId: "t-1", match: { incidentId: null } }));
		await collectSse(response);
		const callArgs = resumeAgentMock.mock.calls as unknown as unknown[][];
		const args = callArgs[0]?.[0] as { resumeValue?: { incidentId?: string | null } };
		expect(args.resumeValue).toEqual({ incidentId: null });
	});

	test("review resume forwards the decisions map", async () => {
		resumeAgentMock.mockClear();
		const response = await POST(
			makeRequest({ threadId: "t-1", review: { decisions: { "rc-1": "approve", "fact-1": "reject" } } }),
		);
		await collectSse(response);
		const callArgs = resumeAgentMock.mock.calls as unknown as unknown[][];
		const args = callArgs[0]?.[0] as { resumeValue?: { decisions?: Record<string, string> } };
		expect(args.resumeValue).toEqual({ decisions: { "rc-1": "approve", "fact-1": "reject" } });
	});

	test("a chained interrupt (match -> review) re-emits the gate and skips done", async () => {
		getPendingInterruptMock.mockImplementationOnce(async () => ({ value: { type: "hil_learning_review" } }));
		emitHilLearningInterruptMock.mockImplementationOnce(() => true);

		const response = await POST(makeRequest({ threadId: "t-1", match: { incidentId: "inc-1" } }));
		const events = await collectSse(response);

		expect(events.some((e) => e.type === "done")).toBe(false);
	});
});

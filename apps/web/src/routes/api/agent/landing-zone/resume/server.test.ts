import { describe, expect, mock, test } from "bun:test";
import { EventEmitter } from "node:events";

mock.module("@devops-agent/agent", () => ({
	flushLangSmithCallbacks: mock(() => Promise.resolve()),
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
	buildEvidenceToc: () => undefined,
	isEvidenceTocEnabled: () => false,
	setEvidenceToc: () => undefined,
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
	runUncuratedPurgeSweep: mock(() => Promise.resolve({ incidents: 0, edges: 0 })),
	purgeCronEnabled: mock(() => false),
	getWorkspaceRoot: mock(() => "/tmp"),
	registerSchedules: mock(() => []),
	selectedBackend: mock(() => "file" as const),
	promoteToMemory: mock(() => Promise.resolve()),
	executeAction: mock(() => Promise.resolve()),
	getAvailableActionTools: mock(() => [] as unknown[]),
}));

mock.module("@devops-agent/observability", () => ({
	traceSpan: mock(async (_name: string, _op: string, fn: () => Promise<unknown>) => fn()),
	getLogger: mock(() => ({ info: mock(() => undefined), error: mock(() => undefined), warn: mock(() => undefined) })),
	runWithRequestContext: mock(async (_context: unknown, fn: () => Promise<unknown>) => fn()),
}));

mock.module("$lib/server/langsmith-tags", () => ({ buildLangSmithTags: mock(() => ["chat", "resumed"]) }));

const resumeAgentMock = mock(
	async (): Promise<AsyncIterable<Record<string, unknown>>> => ({
		async *[Symbol.asyncIterator]() {},
	}),
);
let pendingQueue: Array<{ value: unknown } | undefined> = [];
const getPendingInterruptMock = mock(async () => pendingQueue.shift());
const landingZoneTelemetry = {
	agent: "landing-zone-terraform",
	intent: "propose-change",
	repositories: ["aws-lz-account-creator"],
	evidenceAvailability: {
		gitlab: "collected",
		okf: "collected",
		terraformDocs: "collected",
		awsDocs: "collected",
		awsApi: "skipped",
		memory: "collected",
		knowledgeGraph: "collected",
	},
	riskTier: "high",
	outcome: "answered",
	graphUsed: true,
	memoryUsed: true,
	knowledgeGraphUsed: true,
} as const;
function seedPending(...values: Array<{ value: unknown } | undefined>) {
	pendingQueue = values;
}

mock.module("$lib/server/agent", () => ({
	resumeAgent: resumeAgentMock,
	getPendingInterrupt: getPendingInterruptMock,
	getPipelineNodes: mock(async () => new Set(["reviewGate", "openMergeRequest", "watchPipeline"])),
	getLastAssistantText: mock(async () => "The proposal was handled."),
	getLandingZoneTurnTelemetry: mock(async () => landingZoneTelemetry),
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

const emitLandingZoneInterruptMock = mock(() => false);
mock.module("$lib/server/sse-pump", () => ({
	pumpEventStream: mock(async (events: AsyncIterable<Record<string, unknown>>) => {
		for await (const _event of events) {
			// Drain the stream.
		}
		return { toolsUsed: [] as string[] };
	}),
	emitLandingZoneInterrupt: emitLandingZoneInterruptMock,
	emitHilLearningInterrupt: mock(() => false),
	emitTopicShiftPrompt: mock(() => false),
	emitIacInterrupt: mock(() => false),
}));

const { POST } = await import("./+server.ts");
const reviewId = "11111111-1111-4111-8111-111111111111";

function request(body: unknown): Parameters<typeof POST>[0] {
	return {
		request: new Request("http://localhost/api/agent/landing-zone/resume", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		}),
	} as Parameters<typeof POST>[0];
}

async function events(response: Response): Promise<Record<string, unknown>[]> {
	const text = await response.text();
	return text
		.split("\n")
		.filter((line) => line.startsWith("data: "))
		.map((line) => JSON.parse(line.slice(6)) as Record<string, unknown>);
}

describe("POST /api/agent/landing-zone/resume", () => {
	test("rejects malformed or mixed decision payloads", async () => {
		expect((await POST(request({ threadId: "t", reviewId, decision: "reject" }))).status).toBe(400);
		expect((await POST(request({ threadId: "t", reviewId, decision: "amend", instructions: " " }))).status).toBe(400);
		expect((await POST(request({ threadId: "t", reviewId, decision: "approve", reason: "extra" }))).status).toBe(400);
	});

	test("rejects a stale resume when no Landing Zone review is pending", async () => {
		seedPending(undefined);
		expect((await POST(request({ threadId: "t", reviewId, decision: "approve" }))).status).toBe(409);
	});

	test("rejects a review capability that does not own the pending gate", async () => {
		seedPending({ value: { type: "landing_zone_plan_review", review: { reviewId } } });
		const response = await POST(
			request({ threadId: "t", reviewId: "22222222-2222-4222-8222-222222222222", decision: "approve" }),
		);
		expect(response.status).toBe(403);
		expect(resumeAgentMock).not.toHaveBeenCalled();
	});

	test.each([
		[{ decision: "approve" }, { decision: "approve" }],
		[
			{ decision: "reject", reason: "Wrong OU" },
			{ decision: "reject", reason: "Wrong OU" },
		],
		[
			{ decision: "amend", instructions: "Use the approved owner" },
			{ decision: "amend", instructions: "Use the approved owner" },
		],
	] as const)("forwards the exact %s decision union", async (body, expected) => {
		resumeAgentMock.mockClear();
		seedPending({ value: { type: "landing_zone_plan_review", review: { reviewId } } }, undefined);
		const response = await POST(request({ threadId: "thread-lz", reviewId, ...body }));
		const streamed = await events(response);
		const args = (resumeAgentMock.mock.calls as unknown as unknown[][])[0]?.[0] as { resumeValue?: unknown };
		expect(args.resumeValue).toEqual(expected);
		expect(streamed[0]?.type).toBe("landing_zone_review_resolved");
		expect(streamed.at(-1)?.type).toBe("done");
		expect(streamed.at(-1)?.telemetry).toEqual(landingZoneTelemetry);
		const invokeOptions = (resumeAgentMock.mock.calls as unknown as unknown[][])[0]?.[0] as {
			metadata?: Record<string, unknown>;
		};
		expect(invokeOptions.metadata).toMatchObject({ agent_id: "landing-zone-terraform", graph_used: true });
	});

	test("re-emits an amended review and does not finalize the turn", async () => {
		seedPending(
			{ value: { type: "landing_zone_plan_review", review: { reviewId } } },
			{ value: { type: "landing_zone_plan_review", review: { reviewId } } },
		);
		emitLandingZoneInterruptMock.mockImplementationOnce(() => true);
		const response = await POST(
			request({ threadId: "thread-lz", reviewId, decision: "amend", instructions: "Use the approved owner" }),
		);
		const streamed = await events(response);
		expect(streamed.some((event) => event.type === "done")).toBeFalse();
	});

	test("restores the pending review when graph resume throws", async () => {
		emitLandingZoneInterruptMock.mockClear();
		resumeAgentMock.mockRejectedValueOnce(new Error("resume failed"));
		const pending = { value: { type: "landing_zone_plan_review", review: { reviewId } } };
		seedPending(pending);
		const response = await POST(request({ threadId: "thread-lz", reviewId, decision: "approve" }));
		const streamed = await events(response);
		expect(emitLandingZoneInterruptMock).toHaveBeenCalledWith(expect.any(Function), "thread-lz", pending.value);
		expect(streamed.some((event) => event.type === "error")).toBeTrue();
	});
});

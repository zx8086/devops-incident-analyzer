// apps/web/src/routes/api/agent/topic-shift/+server.test.ts
import { describe, expect, mock, test } from "bun:test";

mock.module("@devops-agent/agent", () => ({
	flushLangSmithCallbacks: mock(() => Promise.resolve()),
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

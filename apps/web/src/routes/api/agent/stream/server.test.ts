// apps/web/src/routes/api/agent/stream/server.test.ts
import { describe, expect, mock, test } from "bun:test";
import { z } from "zod";

mock.module("@devops-agent/agent", () => ({
	AttachmentError: class AttachmentError extends Error {},
	flushLangSmithCallbacks: mock(() => Promise.resolve()),
	processAttachments: mock(() => Promise.resolve({ contentBlocks: [], metadata: [], warnings: [] })),
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

// SIO-586: AttachmentBlockSchema and DataSourceContextSchema are composed via real
// Zod operators (z.array(...), .optional()) at module load. They must be real Zod
// schemas, not plain `.parse` stubs, or the handler module will fail to import.
mock.module("@devops-agent/shared", () => ({
	AttachmentBlockSchema: z.any(),
	DataSourceContextSchema: z.any(),
	redactPiiContent: (s: string) => s,
}));

const invokeAgentMock = mock(
	async (): Promise<AsyncIterable<Record<string, unknown>>> => ({
		async *[Symbol.asyncIterator]() {
			// no events
		},
	}),
);

// SIO-751: getPendingInterrupt is called after the stream drains to check
// whether the graph paused on detectTopicShift. In the happy-path tests below
// no interrupt is ever raised, so a stub returning undefined keeps the existing
// done-event path intact.
const buildLangSmithTagsMock = mock(() => [] as string[]);
mock.module("$lib/server/langsmith-tags", () => ({
	buildLangSmithTags: buildLangSmithTagsMock,
}));

mock.module("$lib/server/agent", () => ({
	invokeAgent: invokeAgentMock,
	getPendingInterrupt: mock(async () => undefined),
}));

const { POST } = await import("./+server.ts");

function makeRequest(body: unknown): Parameters<typeof POST>[0] {
	const request = new Request("http://localhost/api/agent/stream", {
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

describe("POST /api/agent/stream — validation", () => {
	test("returns 400 for missing messages field", async () => {
		const response = await POST(makeRequest({ threadId: "t-1" }));
		expect(response.status).toBe(400);
		const body = (await response.json()) as { error: string };
		expect(body.error).toBe("Invalid request");
	});

	test("returns 400 for invalid role enum", async () => {
		const response = await POST(makeRequest({ messages: [{ role: "system", content: "x" }] }));
		expect(response.status).toBe(400);
		const body = (await response.json()) as { error: string };
		expect(body.error).toBe("Invalid request");
	});

	test("returns 400 for non-JSON body", async () => {
		const request = new Request("http://localhost/api/agent/stream", {
			method: "POST",
			body: "not-json",
		});
		const response = await POST({ request } as Parameters<typeof POST>[0]);
		expect(response.status).toBe(400);
	});
});

describe("POST /api/agent/stream — SSE stream", () => {
	test("emits run_id, forwards aggregator chunks, then done", async () => {
		invokeAgentMock.mockImplementationOnce(async () => ({
			async *[Symbol.asyncIterator]() {
				yield {
					event: "on_chain_start",
					name: "classify",
				};
				yield {
					event: "on_chain_end",
					name: "classify",
					data: { output: {} },
				};
				yield {
					event: "on_chat_model_stream",
					tags: ["aggregate"],
					metadata: { langgraph_node: "aggregate" },
					data: { chunk: { content: "Hello " } },
				};
				yield {
					event: "on_chat_model_stream",
					tags: ["aggregate"],
					metadata: { langgraph_node: "aggregate" },
					data: { chunk: { content: "world." } },
				};
			},
		}));

		const response = await POST(
			makeRequest({
				messages: [{ role: "user", content: "ping" }],
				threadId: "thread-abc",
			}),
		);

		expect(response.status).toBe(200);
		expect(response.headers.get("Content-Type")).toBe("text/event-stream");

		const events = await collectSse(response);
		const types = events.map((e) => e.type);

		expect(types[0]).toBe("run_id");
		expect(types).toContain("node_start");
		expect(types).toContain("node_end");
		expect(types.filter((t) => t === "message")).toHaveLength(2);
		expect(types[types.length - 1]).toBe("done");

		const done = events[events.length - 1] as { threadId: string; runId: string };
		expect(done.threadId).toBe("thread-abc");
		expect(typeof done.runId).toBe("string");

		const messageContents = events
			.filter((e) => e.type === "message")
			.map((e) => e.content)
			.join("");
		expect(messageContents).toBe("Hello world.");
	});

	test("only forwards model stream chunks tagged for output nodes", async () => {
		invokeAgentMock.mockImplementationOnce(async () => ({
			async *[Symbol.asyncIterator]() {
				yield {
					event: "on_chat_model_stream",
					tags: ["classify"],
					metadata: { langgraph_node: "classify" },
					data: { chunk: { content: "internal-only" } },
				};
				yield {
					event: "on_chat_model_stream",
					tags: ["responder"],
					metadata: { langgraph_node: "responder" },
					data: { chunk: { content: "user-facing" } },
				};
			},
		}));

		const response = await POST(makeRequest({ messages: [{ role: "user", content: "x" }] }));
		const events = await collectSse(response);
		const messages = events.filter((e) => e.type === "message").map((e) => e.content);
		expect(messages).toEqual(["user-facing"]);
	});
});

describe("POST /api/agent/stream — error path", () => {
	test("emits an SSE error event when the agent throws", async () => {
		invokeAgentMock.mockImplementationOnce(async () => ({
			// biome-ignore lint/correctness/useYield: deliberately throws to exercise the error path
			async *[Symbol.asyncIterator]() {
				throw new Error("agent exploded");
			},
		}));

		const response = await POST(makeRequest({ messages: [{ role: "user", content: "trigger" }] }));
		expect(response.status).toBe(200);

		const events = await collectSse(response);
		const errorEvent = events.find((e) => e.type === "error") as { type: "error"; message: string } | undefined;
		expect(errorEvent).toBeDefined();
		expect(errorEvent?.message).toContain("agent exploded");
	});
});

describe("POST /api/agent/stream — SIO-739 partial_failure", () => {
	test("emits partial_failure for a mitigation branch timeout (SIO-741)", async () => {
		invokeAgentMock.mockImplementationOnce(async () => ({
			async *[Symbol.asyncIterator]() {
				yield {
					event: "on_chain_end",
					name: "proposeMonitor",
					data: {
						output: {
							partialFailures: [{ node: "proposeMitigation.monitor", reason: "timeout" }],
						},
					},
				};
			},
		}));

		const response = await POST(makeRequest({ messages: [{ role: "user", content: "x" }] }));
		const events = await collectSse(response);

		const failureEvents = events.filter((e) => e.type === "partial_failure");
		expect(failureEvents).toHaveLength(1);
		expect(failureEvents[0]).toMatchObject({
			type: "partial_failure",
			node: "proposeMitigation.monitor",
			reason: "timeout",
		});
	});

	test("emits two partial_failure events when a branch and the action-proposal step both timed out (SIO-741)", async () => {
		invokeAgentMock.mockImplementationOnce(async () => ({
			async *[Symbol.asyncIterator]() {
				yield {
					event: "on_chain_end",
					name: "aggregateMitigation",
					data: {
						output: {
							partialFailures: [
								{ node: "proposeMitigation.monitor", reason: "timeout" },
								{ node: "proposeMitigation.actionProposal", reason: "timeout" },
							],
						},
					},
				};
			},
		}));

		const response = await POST(makeRequest({ messages: [{ role: "user", content: "x" }] }));
		const events = await collectSse(response);

		const failureEvents = events.filter((e) => e.type === "partial_failure");
		expect(failureEvents).toHaveLength(2);
		expect(failureEvents.map((e) => e.node)).toEqual(["proposeMitigation.monitor", "proposeMitigation.actionProposal"]);
	});

	test("emits partial_failure for followUp timeout", async () => {
		invokeAgentMock.mockImplementationOnce(async () => ({
			async *[Symbol.asyncIterator]() {
				yield {
					event: "on_chain_end",
					name: "followUp",
					data: {
						output: {
							partialFailures: [{ node: "followUp", reason: "timeout" }],
						},
					},
				};
			},
		}));

		const response = await POST(makeRequest({ messages: [{ role: "user", content: "x" }] }));
		const events = await collectSse(response);

		const failureEvents = events.filter((e) => e.type === "partial_failure");
		expect(failureEvents).toHaveLength(1);
		expect(failureEvents[0]).toMatchObject({
			type: "partial_failure",
			node: "followUp",
			reason: "timeout",
		});
	});

	test("de-dups partial_failure events with identical node+reason key across nodes", async () => {
		// Same key reported by both aggregateMitigation and followUp on_chain_end events
		// must emit only one SSE event.
		invokeAgentMock.mockImplementationOnce(async () => ({
			async *[Symbol.asyncIterator]() {
				yield {
					event: "on_chain_end",
					name: "aggregateMitigation",
					data: {
						output: {
							partialFailures: [{ node: "proposeMitigation.monitor", reason: "timeout" }],
						},
					},
				};
				yield {
					event: "on_chain_end",
					name: "followUp",
					data: {
						output: {
							partialFailures: [{ node: "proposeMitigation.monitor", reason: "timeout" }],
						},
					},
				};
			},
		}));

		const response = await POST(makeRequest({ messages: [{ role: "user", content: "x" }] }));
		const events = await collectSse(response);

		const failureEvents = events.filter((e) => e.type === "partial_failure");
		expect(failureEvents).toHaveLength(1);
	});

	test("ignores non-array partialFailures payload", async () => {
		invokeAgentMock.mockImplementationOnce(async () => ({
			async *[Symbol.asyncIterator]() {
				yield {
					event: "on_chain_end",
					name: "aggregateMitigation",
					data: {
						output: {
							partialFailures: "not-an-array",
						},
					},
				};
			},
		}));

		const response = await POST(makeRequest({ messages: [{ role: "user", content: "x" }] }));
		const events = await collectSse(response);

		const failureEvents = events.filter((e) => e.type === "partial_failure");
		expect(failureEvents).toHaveLength(0);
	});

	test("skips malformed failure entries lacking node or reason strings", async () => {
		invokeAgentMock.mockImplementationOnce(async () => ({
			async *[Symbol.asyncIterator]() {
				yield {
					event: "on_chain_end",
					name: "aggregateMitigation",
					data: {
						output: {
							partialFailures: [
								{ node: 42, reason: "timeout" },
								{ node: "proposeMitigation.monitor", reason: null },
								null,
								{ node: "proposeMitigation.monitor", reason: "timeout" },
							],
						},
					},
				};
			},
		}));

		const response = await POST(makeRequest({ messages: [{ role: "user", content: "x" }] }));
		const events = await collectSse(response);

		const failureEvents = events.filter((e) => e.type === "partial_failure");
		expect(failureEvents).toHaveLength(1);
		expect(failureEvents[0]).toMatchObject({
			type: "partial_failure",
			node: "proposeMitigation.monitor",
			reason: "timeout",
		});
	});
});

describe("POST /api/agent/stream — lifecycle logging", () => {
	test("emits agent.request.start with correlation IDs via runWithRequestContext", async () => {
		sharedLogger.info.mockClear();
		runWithRequestContextMock.mockClear();

		await POST(makeRequest({ messages: [{ role: "user", content: "hi" }] }));

		const allInfoCalls = sharedLogger.info.mock.calls as unknown as unknown[][];
		const startCalls = allInfoCalls.filter(
			(c) => c[c.length - 1] === "agent.request.start" || c[0] === "agent.request.start",
		);
		expect(startCalls.length).toBeGreaterThan(0);

		expect(runWithRequestContextMock).toHaveBeenCalled();
		const ctxCalls = runWithRequestContextMock.mock.calls as unknown as unknown[][];
		const ctx = ctxCalls[0]?.[0] as { threadId: string; runId: string; requestId: string };
		expect(typeof ctx.threadId).toBe("string");
		expect(typeof ctx.runId).toBe("string");
		expect(typeof ctx.requestId).toBe("string");
	});

	test("emits agent.request.end with responseTime + toolsUsed after happy path", async () => {
		sharedLogger.info.mockClear();
		invokeAgentMock.mockImplementationOnce(async () => ({
			async *[Symbol.asyncIterator]() {
				// empty stream — done event still fires
			},
		}));

		const response = await POST(makeRequest({ messages: [{ role: "user", content: "hi" }] }));
		await collectSse(response);

		const infoCalls = sharedLogger.info.mock.calls as unknown as unknown[][];
		const endCall = infoCalls.find((c) => c[c.length - 1] === "agent.request.end" || c[0] === "agent.request.end");
		expect(endCall).toBeDefined();
		// Pino call shape: logger.info(meta, msg). meta is the first arg.
		const meta = endCall?.[0] as { responseTime?: number; toolsUsed?: number };
		expect(typeof meta.responseTime).toBe("number");
		expect(typeof meta.toolsUsed).toBe("number");
	});

	test("emits agent.request.error when invokeAgent throws", async () => {
		sharedLogger.error.mockClear();
		invokeAgentMock.mockImplementationOnce(async () => {
			throw new Error("boom");
		});

		const response = await POST(makeRequest({ messages: [{ role: "user", content: "hi" }] }));
		await collectSse(response);

		const errorCalls = sharedLogger.error.mock.calls as unknown as unknown[][];
		const errCall = errorCalls.find((c) => c[c.length - 1] === "agent.request.error" || c[0] === "agent.request.error");
		expect(errCall).toBeDefined();
		const meta = errCall?.[0] as { err?: { message?: string } };
		expect(meta.err?.message).toBe("boom");
	});

	test("invokeAgent receives runName 'agent.request' and chat tags", async () => {
		invokeAgentMock.mockClear();
		buildLangSmithTagsMock.mockClear();
		buildLangSmithTagsMock.mockImplementationOnce(
			() => ["chat", "thread:xyz", "datasources:elastic,kafka", "follow-up"] as string[],
		);

		await POST(
			makeRequest({
				messages: [{ role: "user", content: "hi" }],
				threadId: "xyz",
				dataSources: ["elastic", "kafka"],
				isFollowUp: true,
			}),
		);

		expect(invokeAgentMock).toHaveBeenCalled();
		const agentCalls = invokeAgentMock.mock.calls as unknown as unknown[][];
		const args = agentCalls[0]?.[1] as { runName?: string; tags?: string[] };
		expect(args.runName).toBe("agent.request");
		expect(args.tags).toContain("chat");
		expect(args.tags).toContain("thread:xyz");
		expect(args.tags).toContain("datasources:elastic,kafka");
		expect(args.tags).toContain("follow-up");

		expect(buildLangSmithTagsMock).toHaveBeenCalledWith({
			threadId: "xyz",
			dataSources: ["elastic", "kafka"],
			isFollowUp: true,
		});
	});
});

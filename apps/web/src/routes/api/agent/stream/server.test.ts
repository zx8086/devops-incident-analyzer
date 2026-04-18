// apps/web/src/routes/api/agent/stream/server.test.ts
import { describe, expect, mock, test } from "bun:test";
import { z } from "zod";

mock.module("@devops-agent/agent", () => ({
	AttachmentError: class AttachmentError extends Error {},
	flushLangSmithCallbacks: mock(() => Promise.resolve()),
	processAttachments: mock(() => Promise.resolve({ contentBlocks: [], metadata: [], warnings: [] })),
}));

mock.module("@devops-agent/observability", () => ({
	traceSpan: mock(async (_name: string, _op: string, fn: () => Promise<unknown>) => fn()),
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

mock.module("$lib/server/agent", () => ({
	invokeAgent: invokeAgentMock,
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

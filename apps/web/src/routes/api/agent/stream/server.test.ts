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

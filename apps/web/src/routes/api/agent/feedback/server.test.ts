// apps/web/src/routes/api/agent/feedback/server.test.ts

// SIO-1890: thumbs feedback reaches the thread's learning candidates before the
// LangSmith write, and never fails the request when memory fails.
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

const recordTurnFeedback = mock(async (_agent: string, _thread: string, _score: number) => ({ transitions: 1 }));
mock.module("@devops-agent/agent", () => ({ recordTurnFeedback }));

const { POST } = await import("./+server.ts");

const realFetch = globalThis.fetch;
let langsmithCalls = 0;
const prevKey = process.env.LANGSMITH_API_KEY;

function post(body: Record<string, unknown>) {
	return POST({
		request: new Request("http://localhost/api/agent/feedback", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		}),
	} as Parameters<typeof POST>[0]);
}

beforeEach(() => {
	recordTurnFeedback.mockClear();
	langsmithCalls = 0;
	process.env.LANGSMITH_API_KEY = "test-key";
	globalThis.fetch = (async () => {
		langsmithCalls += 1;
		return new Response("{}", { status: 200 });
	}) as unknown as typeof fetch;
});

afterEach(() => {
	globalThis.fetch = realFetch;
	if (prevKey === undefined) delete process.env.LANGSMITH_API_KEY;
	else process.env.LANGSMITH_API_KEY = prevKey;
});

describe("POST /api/agent/feedback (SIO-1890)", () => {
	test("records the verdict against the thread's candidates, then LangSmith", async () => {
		const res = await post({ runId: "r1", score: 0, threadId: "t1", agentName: "elastic-iac" });
		expect(res.status).toBe(200);
		expect(recordTurnFeedback).toHaveBeenCalledWith("elastic-iac", "t1", 0);
		expect(langsmithCalls).toBe(1);
	});

	test("an older client without threadId still reaches LangSmith and touches no candidate", async () => {
		const res = await post({ runId: "r1", score: 1 });
		expect(res.status).toBe(200);
		expect(recordTurnFeedback).not.toHaveBeenCalled();
		expect(langsmithCalls).toBe(1);
	});

	test("a memory failure never fails the request", async () => {
		recordTurnFeedback.mockImplementationOnce(async () => {
			throw new Error("capella down");
		});
		const res = await post({ runId: "r1", score: 1, threadId: "t1", agentName: "incident-analyzer" });
		expect(res.status).toBe(200);
		expect(langsmithCalls).toBe(1);
	});
});

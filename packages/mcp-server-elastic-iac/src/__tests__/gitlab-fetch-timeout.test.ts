// src/__tests__/gitlab-fetch-timeout.test.ts
import { afterEach, describe, expect, test } from "bun:test";
import { gitlabFetch } from "../tools/shared.ts";

// SIO-1478: gitlabFetch had no deadline. A stalled GitLab connection blocked the
// caller indefinitely -- observed live at 136,597ms against a ~250ms baseline --
// and because this MCP server serves requests on one event loop, the agent's
// /identity probe (1s budget) went unanswered and the server was marked "down"
// while it was healthy either side of the stall.

const realFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = realFetch;
	delete Bun.env.ELASTIC_IAC_GITLAB_TIMEOUT_MS;
});

describe("gitlabFetch timeout", () => {
	test("a stalled request aborts instead of hanging, and names the timeout", async () => {
		Bun.env.ELASTIC_IAC_GITLAB_TIMEOUT_MS = "50";
		// Never resolves on its own; only the injected signal can end it.
		globalThis.fetch = ((_url: string, init?: RequestInit) =>
			new Promise((_resolve, reject) => {
				init?.signal?.addEventListener("abort", () => {
					const err = new Error("The operation was aborted due to timeout");
					err.name = "TimeoutError";
					reject(err);
				});
			})) as typeof fetch;

		const started = Date.now();
		const out = await gitlabFetch("https://gitlab.test", "tok", "/projects/1/merge_requests");
		const elapsed = Date.now() - started;

		expect(out).toContain("timed out after 50ms");
		expect(out).toContain("/projects/1/merge_requests");
		// The point of the fix: it returns promptly rather than blocking the loop.
		expect(elapsed).toBeLessThan(2_000);
	});

	test("passes an abort signal to fetch by default", async () => {
		let seenSignal: AbortSignal | null | undefined;
		globalThis.fetch = ((_url: string, init?: RequestInit) => {
			seenSignal = init?.signal;
			return Promise.resolve(new Response("[]", { status: 200 }));
		}) as typeof fetch;

		await gitlabFetch("https://gitlab.test", "tok", "/projects/1");
		expect(seenSignal).toBeInstanceOf(AbortSignal);
	});

	test("a caller-supplied signal is preserved, not overwritten", async () => {
		const controller = new AbortController();
		let seenSignal: AbortSignal | null | undefined;
		globalThis.fetch = ((_url: string, init?: RequestInit) => {
			seenSignal = init?.signal;
			return Promise.resolve(new Response("[]", { status: 200 }));
		}) as typeof fetch;

		await gitlabFetch("https://gitlab.test", "tok", "/projects/1", { signal: controller.signal });
		expect(seenSignal).toBe(controller.signal);
	});

	test("a successful response is unchanged by the timeout wiring", async () => {
		globalThis.fetch = (() => Promise.resolve(new Response('[{"iid":7}]', { status: 200 }))) as typeof fetch;

		const out = await gitlabFetch("https://gitlab.test", "tok", "/projects/1/merge_requests");
		expect(out).toBe('[200] [{"iid":7}]');
	});

	test("a non-timeout failure keeps its original message", async () => {
		globalThis.fetch = (() => Promise.reject(new Error("ECONNREFUSED"))) as typeof fetch;

		const out = await gitlabFetch("https://gitlab.test", "tok", "/projects/1");
		expect(out).toContain("gitlab request failed");
		expect(out).toContain("ECONNREFUSED");
		expect(out).not.toContain("timed out");
	});

	test("an invalid override falls back to the 30s default rather than disabling the timeout", async () => {
		Bun.env.ELASTIC_IAC_GITLAB_TIMEOUT_MS = "not-a-number";
		let seenSignal: AbortSignal | null | undefined;
		globalThis.fetch = ((_url: string, init?: RequestInit) => {
			seenSignal = init?.signal;
			return Promise.resolve(new Response("[]", { status: 200 }));
		}) as typeof fetch;

		await gitlabFetch("https://gitlab.test", "tok", "/projects/1");
		expect(seenSignal).toBeInstanceOf(AbortSignal);
		expect(seenSignal?.aborted).toBe(false);
	});

	test("missing token short-circuits before any fetch", async () => {
		let called = false;
		globalThis.fetch = (() => {
			called = true;
			return Promise.resolve(new Response("", { status: 200 }));
		}) as typeof fetch;

		const out = await gitlabFetch("https://gitlab.test", undefined, "/projects/1");
		expect(out).toContain("gitlab token not configured");
		expect(called).toBe(false);
	});
});

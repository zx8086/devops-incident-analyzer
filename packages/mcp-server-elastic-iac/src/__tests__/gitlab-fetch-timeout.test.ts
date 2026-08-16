// src/__tests__/gitlab-fetch-timeout.test.ts
import { afterEach, describe, expect, test } from "bun:test";
import { gitlabFetch } from "../tools/shared.ts";

// SIO-1478: gitlabFetch had no deadline. A stalled GitLab connection blocked the
// caller indefinitely -- observed live at 136,597ms against a ~250ms baseline --
// and because this MCP server serves requests on one event loop, the agent's
// /identity probe (1s budget) went unanswered and the server was marked "down"
// while it was healthy either side of the stall.

const realFetch = globalThis.fetch;
// CodeRabbit: the deleted key may have been supplied by the test process, so
// capture and restore it rather than unconditionally removing it.
const originalTimeoutEnv = Bun.env.ELASTIC_IAC_GITLAB_TIMEOUT_MS;

afterEach(() => {
	globalThis.fetch = realFetch;
	if (originalTimeoutEnv === undefined) delete Bun.env.ELASTIC_IAC_GITLAB_TIMEOUT_MS;
	else Bun.env.ELASTIC_IAC_GITLAB_TIMEOUT_MS = originalTimeoutEnv;
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
			})) as unknown as typeof fetch;

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
		}) as unknown as typeof fetch;

		await gitlabFetch("https://gitlab.test", "tok", "/projects/1");
		expect(seenSignal).toBeInstanceOf(AbortSignal);
	});

	test("a caller-supplied signal is preserved, not overwritten", async () => {
		const controller = new AbortController();
		let seenSignal: AbortSignal | null | undefined;
		globalThis.fetch = ((_url: string, init?: RequestInit) => {
			seenSignal = init?.signal;
			return Promise.resolve(new Response("[]", { status: 200 }));
		}) as unknown as typeof fetch;

		await gitlabFetch("https://gitlab.test", "tok", "/projects/1", { signal: controller.signal });
		expect(seenSignal).toBe(controller.signal);
	});

	test("a successful response is unchanged by the timeout wiring", async () => {
		globalThis.fetch = (() => Promise.resolve(new Response('[{"iid":7}]', { status: 200 }))) as unknown as typeof fetch;

		const out = await gitlabFetch("https://gitlab.test", "tok", "/projects/1/merge_requests");
		expect(out).toBe('[200] [{"iid":7}]');
	});

	test("a non-timeout failure keeps its original message", async () => {
		globalThis.fetch = (() => Promise.reject(new Error("ECONNREFUSED"))) as unknown as typeof fetch;

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
		}) as unknown as typeof fetch;

		await gitlabFetch("https://gitlab.test", "tok", "/projects/1");
		expect(seenSignal).toBeInstanceOf(AbortSignal);
		expect(seenSignal?.aborted).toBe(false);
	});

	test("missing token short-circuits before any fetch", async () => {
		let called = false;
		globalThis.fetch = (() => {
			called = true;
			return Promise.resolve(new Response("", { status: 200 }));
		}) as unknown as typeof fetch;

		const out = await gitlabFetch("https://gitlab.test", undefined, "/projects/1");
		expect(out).toContain("gitlab token not configured");
		expect(called).toBe(false);
	});
});

// Greptile (PR #673): parseInt stops at the first non-digit, so a unit-bearing
// value silently became a tiny deadline -- "30s" -> 30ms, "30_000" -> 30ms.
// Both are plausible operator input and both turn the safety net into a
// guaranteed failure, so the whole string must be digits.
describe("gitlabFetch timeout override parsing", () => {
	// Read the configured deadline WITHOUT waiting for it: capture the signal
	// handed to fetch and abort it immediately, so a 30s fallback does not cost
	// 30s of test time. AbortSignal.timeout exposes no duration, so the value is
	// recovered from the message gitlabFetch produces on its own timeout path.
	async function timeoutUsedFor(raw: string | undefined): Promise<number> {
		if (raw === undefined) delete Bun.env.ELASTIC_IAC_GITLAB_TIMEOUT_MS;
		else Bun.env.ELASTIC_IAC_GITLAB_TIMEOUT_MS = raw;
		globalThis.fetch = ((_u: string, init?: RequestInit) =>
			new Promise((_res, reject) => {
				// Simulate the deadline firing right away, whatever its length.
				queueMicrotask(() => {
					const e = new Error("The operation was aborted due to timeout");
					e.name = "TimeoutError";
					reject(e);
				});
				void init;
			})) as unknown as typeof fetch;
		const out = await gitlabFetch("https://gitlab.test", "tok", "/p/1");
		return Number.parseInt(/timed out after (\d+)ms/.exec(out)?.[1] ?? "-1", 10);
	}

	test('"30s" falls back to 30000ms rather than becoming a 30ms deadline', async () => {
		expect(await timeoutUsedFor("30s")).toBe(30_000);
	});

	test('"30_000" falls back to 30000ms rather than becoming a 30ms deadline', async () => {
		expect(await timeoutUsedFor("30_000")).toBe(30_000);
	});

	test("a plain integer is honoured", async () => {
		expect(await timeoutUsedFor("75")).toBe(75);
	});

	test("surrounding whitespace is tolerated", async () => {
		expect(await timeoutUsedFor("  90  ")).toBe(90);
	});

	test('"0" falls back to the default', async () => {
		expect(await timeoutUsedFor("0")).toBe(30_000);
	});

	// CodeRabbit: parseInt("50ms") === 50 and parseInt("1.5") === 1 both bypassed
	// the intended positive-integer validation before readPositiveIntEnv.
	test('"50ms" falls back to the default', async () => {
		expect(await timeoutUsedFor("50ms")).toBe(30_000);
	});

	test('"1.5" falls back to the default rather than becoming 1ms', async () => {
		expect(await timeoutUsedFor("1.5")).toBe(30_000);
	});

	test('"-5" falls back to the default', async () => {
		expect(await timeoutUsedFor("-5")).toBe(30_000);
	});
});

// Greptile (PR #673): when the caller supplies a signal, OUR timeout is never
// armed -- claiming "timed out after 30000ms" would assert a deadline that
// never existed, the same class of false claim SIO-1477/1478 exist to remove.
describe("gitlabFetch distinguishes caller cancellation from its own timeout", () => {
	test("a caller abort reports cancellation, not expiry of the configured timeout", async () => {
		const controller = new AbortController();
		globalThis.fetch = ((_u: string, init?: RequestInit) =>
			new Promise((_res, reject) => {
				init?.signal?.addEventListener("abort", () => {
					const e = new Error("The operation was aborted.");
					e.name = "AbortError";
					reject(e);
				});
			})) as unknown as typeof fetch;

		const pending = gitlabFetch("https://gitlab.test", "tok", "/p/1", { signal: controller.signal });
		controller.abort();
		const out = await pending;

		expect(out).toContain("cancelled by caller");
		expect(out).not.toContain("timed out after");
	});
});

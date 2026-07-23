// test/embeddings-retry.test.ts
// SIO-1179: callWithEmbeddingsRetry -- single 15s retry (injectable delay), timeout
// short-circuit, and the structured { _error } envelope on both guidance paths.

import { describe, expect, test } from "bun:test";
import type { GitLabMcpProxy } from "../src/gitlab-client/proxy.js";
import { callWithEmbeddingsRetry } from "../src/tools/proxy/index.js";

const NOT_READY = {
	content: [{ type: "text", text: "No embeddings available -- indexing has been started for this project" }],
	isError: true,
};
const READY = { content: [{ type: "text", text: '{"results":[]}' }] };

function proxyWith(callTool: (...args: unknown[]) => Promise<unknown>): GitLabMcpProxy {
	return { callTool } as unknown as GitLabMcpProxy;
}

describe("callWithEmbeddingsRetry (SIO-1179)", () => {
	test("passes a ready result through untouched on the first attempt", async () => {
		let calls = 0;
		const proxy = proxyWith(async () => {
			calls += 1;
			return READY;
		});
		const result = await callWithEmbeddingsRetry(proxy, "semantic_code_search", "gitlab_semantic_code_search", {}, 0);
		expect(result).toEqual(READY);
		expect(calls).toBe(1);
	});

	test("retries exactly once on not-ready, then succeeds", async () => {
		let calls = 0;
		const proxy = proxyWith(async () => {
			calls += 1;
			return calls === 1 ? NOT_READY : READY;
		});
		const result = await callWithEmbeddingsRetry(proxy, "semantic_code_search", "gitlab_semantic_code_search", {}, 0);
		expect(result).toEqual(READY);
		expect(calls).toBe(2);
	});

	test("still not ready after the single retry -> browse-fallback guidance + no-index envelope", async () => {
		let calls = 0;
		const proxy = proxyWith(async () => {
			calls += 1;
			return NOT_READY;
		});
		const result = await callWithEmbeddingsRetry(proxy, "semantic_code_search", "gitlab_semantic_code_search", {}, 0);
		expect(calls).toBe(2);
		expect(result.isError).toBe(true);
		const text = result.content?.[0]?.text ?? "";
		expect(text).toContain("gitlab_get_repository_tree");
		expect(text).toContain('"kind":"no-index"');
		expect(text).toContain('"category":"no-data"');
	});

	test("timeout short-circuits to guidance with a timeout envelope (no second attempt)", async () => {
		let calls = 0;
		const proxy = proxyWith(async () => {
			calls += 1;
			throw new Error("Request timed out");
		});
		const result = await callWithEmbeddingsRetry(proxy, "semantic_code_search", "gitlab_semantic_code_search", {}, 0);
		expect(calls).toBe(1);
		expect(result.isError).toBe(true);
		const text = result.content?.[0]?.text ?? "";
		expect(text).toContain("timed out");
		expect(text).toContain('"kind":"timeout"');
	});

	test("non-retryable errors are rethrown, not swallowed", async () => {
		const proxy = proxyWith(async () => {
			throw new Error("401 Unauthorized");
		});
		await expect(
			callWithEmbeddingsRetry(proxy, "semantic_code_search", "gitlab_semantic_code_search", {}, 0),
		).rejects.toThrow("401 Unauthorized");
	});
});

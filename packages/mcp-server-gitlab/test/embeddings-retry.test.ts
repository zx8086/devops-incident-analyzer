// test/embeddings-retry.test.ts

import { beforeEach, describe, expect, test } from "bun:test";
import type { GitLabMcpProxy } from "../src/gitlab-client/proxy.js";
import {
	_resetEmbeddingsNotReadyForTest,
	callWithEmbeddingsRetry,
	getEmbeddingsNotReadyProjects,
} from "../src/tools/proxy/index.js";

const NOT_READY = {
	content: [{ type: "text", text: "No embeddings available -- indexing has been started for this project" }],
	isError: true,
};
const READY = { content: [{ type: "text", text: '{"results":[]}' }] };

function proxyWith(callTool: (...args: unknown[]) => Promise<unknown>): GitLabMcpProxy {
	return { callTool } as unknown as GitLabMcpProxy;
}

describe("callWithEmbeddingsRetry (SIO-1179)", () => {
	beforeEach(() => {
		_resetEmbeddingsNotReadyForTest();
	});

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

describe("getEmbeddingsNotReadyProjects (SIO-1209)", () => {
	beforeEach(() => {
		_resetEmbeddingsNotReadyForTest();
	});

	test("records the project after exhausting the retry, with a timestamp", async () => {
		const proxy = proxyWith(async () => NOT_READY);
		await callWithEmbeddingsRetry(proxy, "semantic_code_search", "gitlab_semantic_code_search", { id: "90000001" }, 0);
		const tracked = getEmbeddingsNotReadyProjects();
		expect(tracked).toHaveLength(1);
		expect(tracked[0]?.projectId).toBe("90000001");
		expect(() => new Date(tracked[0]?.lastNotReadyAt ?? "")).not.toThrow();
		expect(Number.isNaN(new Date(tracked[0]?.lastNotReadyAt ?? "").getTime())).toBe(false);
	});

	test("does not record when the project id is absent from args", async () => {
		const proxy = proxyWith(async () => NOT_READY);
		await callWithEmbeddingsRetry(proxy, "semantic_code_search", "gitlab_semantic_code_search", {}, 0);
		expect(getEmbeddingsNotReadyProjects()).toEqual([]);
	});

	test("clears a previously-tracked project once a call succeeds", async () => {
		const notReadyProxy = proxyWith(async () => NOT_READY);
		await callWithEmbeddingsRetry(
			notReadyProxy,
			"semantic_code_search",
			"gitlab_semantic_code_search",
			{ id: "90000001" },
			0,
		);
		expect(getEmbeddingsNotReadyProjects()).toHaveLength(1);

		const readyProxy = proxyWith(async () => READY);
		await callWithEmbeddingsRetry(
			readyProxy,
			"semantic_code_search",
			"gitlab_semantic_code_search",
			{ id: "90000001" },
			0,
		);
		expect(getEmbeddingsNotReadyProjects()).toEqual([]);
	});

	test("tracks multiple distinct projects independently", async () => {
		const proxy = proxyWith(async () => NOT_READY);
		await callWithEmbeddingsRetry(proxy, "semantic_code_search", "gitlab_semantic_code_search", { id: "90000001" }, 0);
		await callWithEmbeddingsRetry(proxy, "semantic_code_search", "gitlab_semantic_code_search", { id: "90000002" }, 0);
		const tracked = getEmbeddingsNotReadyProjects()
			.map((e) => e.projectId)
			.sort();
		expect(tracked).toEqual(["90000001", "90000002"]);
	});

	test("a timeout does not record the project (distinct from confirmed not-ready)", async () => {
		const proxy = proxyWith(async () => {
			throw new Error("Request timed out");
		});
		await callWithEmbeddingsRetry(proxy, "semantic_code_search", "gitlab_semantic_code_search", { id: "90000001" }, 0);
		expect(getEmbeddingsNotReadyProjects()).toEqual([]);
	});

	// CodeRabbit (PR #468): an unrelated upstream error (auth failure, 5xx,
	// malformed response) also fails isEmbeddingsNotReady's regex match, but is
	// NOT evidence the project's embeddings are ready -- must not clear a
	// previously-tracked "not ready" entry for that project.
	test("an unrelated isError result does not clear a previously-tracked project", async () => {
		const notReadyProxy = proxyWith(async () => NOT_READY);
		await callWithEmbeddingsRetry(
			notReadyProxy,
			"semantic_code_search",
			"gitlab_semantic_code_search",
			{ id: "90000001" },
			0,
		);
		expect(getEmbeddingsNotReadyProjects()).toHaveLength(1);

		const UNRELATED_ERROR = {
			content: [{ type: "text", text: "GitLab API error (500): internal error" }],
			isError: true,
		};
		const errorProxy = proxyWith(async () => UNRELATED_ERROR);
		await callWithEmbeddingsRetry(
			errorProxy,
			"semantic_code_search",
			"gitlab_semantic_code_search",
			{ id: "90000001" },
			0,
		);
		expect(getEmbeddingsNotReadyProjects()).toHaveLength(1);
		expect(getEmbeddingsNotReadyProjects()[0]?.projectId).toBe("90000001");
	});
});

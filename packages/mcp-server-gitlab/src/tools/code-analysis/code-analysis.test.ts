// src/tools/code-analysis/code-analysis.test.ts
// SIO-1179: handler-level tests for the six code-analysis REST tools -- registration,
// happy paths against a stubbed GitLabRestClient, and the { _error } envelope on
// GitLabApiError failures.

import { describe, expect, test } from "bun:test";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { GitLabApiError, type GitLabRestClient } from "../../gitlab-client/index.js";
import { registerCodeAnalysisTools } from "../code-analysis-registry.js";

interface ToolResult {
	content: Array<{ type: string; text: string }>;
	isError?: boolean;
}
type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult>;

function stubServer() {
	const handlers = new Map<string, ToolHandler>();
	const server = {
		tool: (name: string, _desc: string, _shape: unknown, handler: ToolHandler) => {
			handlers.set(name, handler);
		},
	} as unknown as McpServer;
	return { server, handlers };
}

const EXPECTED_TOOLS = [
	"gitlab_get_file_content",
	"gitlab_get_blame",
	"gitlab_get_commit_diff",
	"gitlab_list_commits",
	"gitlab_get_repository_tree",
	"gitlab_list_merge_requests",
];

function makeClient(over: Partial<GitLabRestClient>): GitLabRestClient {
	return over as unknown as GitLabRestClient;
}

function register(client: GitLabRestClient) {
	const { server, handlers } = stubServer();
	const count = registerCodeAnalysisTools(server, client);
	return { handlers, count };
}

describe("code-analysis registration", () => {
	test("registers exactly the six documented tools", () => {
		const { handlers, count } = register(makeClient({}));
		expect(count).toBe(6);
		expect(Array.from(handlers.keys()).sort()).toEqual([...EXPECTED_TOOLS].sort());
	});
});

describe("code-analysis happy paths", () => {
	test("gitlab_get_file_content decodes base64 content", async () => {
		const client = makeClient({
			getFileContent: async () => ({
				file_name: "a.ts",
				file_path: "src/a.ts",
				size: 5,
				encoding: "base64",
				content: Buffer.from("hello").toString("base64"),
				ref: "main",
			}),
		});
		const { handlers } = register(client);
		const result = await handlers.get("gitlab_get_file_content")?.({ project_id: "1", file_path: "src/a.ts" });
		expect(result?.isError).toBeFalsy();
		const payload = JSON.parse(result?.content[0]?.text ?? "{}") as { content: string };
		expect(payload.content).toBe("hello");
	});

	test("gitlab_get_blame echoes blame ranges", async () => {
		const client = makeClient({
			getBlame: async () => [{ commit: { id: "abc" }, lines: ["x"] }] as never,
		});
		const { handlers } = register(client);
		const result = await handlers.get("gitlab_get_blame")?.({ project_id: "1", file_path: "src/a.ts" });
		expect(result?.isError).toBeFalsy();
		expect(result?.content[0]?.text).toContain("abc");
	});

	test("gitlab_get_commit_diff echoes diffs", async () => {
		const client = makeClient({
			getCommitDiff: async () => [{ diff: "@@ -1 +1 @@", new_path: "a.ts", old_path: "a.ts" }] as never,
		});
		const { handlers } = register(client);
		const result = await handlers.get("gitlab_get_commit_diff")?.({ project_id: "1", sha: "abc123" });
		expect(result?.isError).toBeFalsy();
		expect(result?.content[0]?.text).toContain("@@ -1 +1 @@");
	});

	test("gitlab_list_commits echoes commits", async () => {
		const client = makeClient({
			listCommits: async () => [{ id: "def456", title: "fix" }] as never,
		});
		const { handlers } = register(client);
		const result = await handlers.get("gitlab_list_commits")?.({ project_id: "1" });
		expect(result?.isError).toBeFalsy();
		expect(result?.content[0]?.text).toContain("def456");
	});

	test("gitlab_get_repository_tree echoes entries", async () => {
		const client = makeClient({
			getRepositoryTree: async () => [{ id: "t1", name: "src", type: "tree", path: "src" }] as never,
		});
		const { handlers } = register(client);
		const result = await handlers.get("gitlab_get_repository_tree")?.({ project_id: "1" });
		expect(result?.isError).toBeFalsy();
		expect(result?.content[0]?.text).toContain("src");
	});

	test("gitlab_list_merge_requests defaults to state=merged", async () => {
		let capturedState: string | undefined;
		const client = makeClient({
			listMergeRequests: async (_id: string | number, opts?: { state?: string }) => {
				capturedState = opts?.state;
				return [{ iid: 350, state: "merged" }] as never;
			},
		});
		const { handlers } = register(client);
		const result = await handlers.get("gitlab_list_merge_requests")?.({ project_id: 82850717 });
		expect(result?.isError).toBeFalsy();
		expect(result?.content[0]?.text).toContain("350");
		expect(capturedState).toBe("merged");
	});
});

describe("code-analysis error envelope (SIO-1179)", () => {
	test("GitLabApiError 404 -> prose first, then a not-found envelope with statusCode", async () => {
		const client = makeClient({
			getFileContent: async () => {
				throw new GitLabApiError("GitLab API error (404): 404 File Not Found", 404);
			},
		});
		const { handlers } = register(client);
		const result = await handlers.get("gitlab_get_file_content")?.({ project_id: "1", file_path: "missing.ts" });
		expect(result?.isError).toBe(true);
		const text = result?.content[0]?.text ?? "";
		expect(text.startsWith("Error: GitLab API error (404)")).toBe(true);
		const envelope = JSON.parse(text.slice(text.indexOf('{"_error"'))) as {
			_error: { kind: string; category: string; statusCode: number };
		};
		expect(envelope._error.kind).toBe("not-found");
		expect(envelope._error.category).toBe("not-found");
		expect(envelope._error.statusCode).toBe(404);
	});

	test("GitLabApiError 401 -> auth-denied envelope", async () => {
		const client = makeClient({
			listMergeRequests: async () => {
				throw new GitLabApiError("GitLab API error (401): Unauthorized", 401);
			},
		});
		const { handlers } = register(client);
		const result = await handlers.get("gitlab_list_merge_requests")?.({ project_id: 1 });
		expect(result?.isError).toBe(true);
		const text = result?.content[0]?.text ?? "";
		expect(text).toContain('"kind":"auth-denied"');
	});

	test("non-HTTP error classifies by message shape (timeout)", async () => {
		const client = makeClient({
			listCommits: async () => {
				throw new Error("Request timed out after 30000ms");
			},
		});
		const { handlers } = register(client);
		const result = await handlers.get("gitlab_list_commits")?.({ project_id: "1" });
		expect(result?.isError).toBe(true);
		expect(result?.content[0]?.text).toContain('"kind":"timeout"');
	});
});

// src/tools/code-analysis-registry.ts

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { GitLabRestClient } from "../gitlab-client/index.js";
import { createContextLogger } from "../utils/logger.js";
import { registerGetBlameTool } from "./code-analysis/get-blame.js";
import { registerGetCommitDiffTool } from "./code-analysis/get-commit-diff.js";
import { registerGetFileContentTool } from "./code-analysis/get-file-content.js";
import { registerGetRepositoryTreeTool } from "./code-analysis/get-repository-tree.js";
import { registerListCommitsTool } from "./code-analysis/list-commits.js";
import { registerListMergeRequestsTool } from "./code-analysis/list-merge-requests.js";

const log = createContextLogger("code-analysis-tools");

export function registerCodeAnalysisTools(server: McpServer, restClient: GitLabRestClient): number {
	registerGetFileContentTool(server, restClient);
	registerGetBlameTool(server, restClient);
	registerGetCommitDiffTool(server, restClient);
	registerListCommitsTool(server, restClient);
	registerGetRepositoryTreeTool(server, restClient);
	registerListMergeRequestsTool(server, restClient);
	const registered = [
		"gitlab_get_file_content",
		"gitlab_get_blame",
		"gitlab_get_commit_diff",
		"gitlab_list_commits",
		"gitlab_get_repository_tree",
		"gitlab_list_merge_requests",
	];
	log.info({ count: registered.length, tools: registered }, "Code analysis tools registered");
	return registered.length;
}

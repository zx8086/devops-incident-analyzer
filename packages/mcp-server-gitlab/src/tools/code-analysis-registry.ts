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

// SIO-771 etc: these are hand-written tools with behavior the upstream GitLab MCP proxy doesn't
// (yet, or reliably) provide -- e.g. list-merge-requests requires numeric project_id, which
// upstream 404s on. Exported so registerAll (server.ts) can filter these names out of the
// discovered proxy tool set before registration, since GitLab's upstream tool surface can add a
// same-named tool at any time and the SDK throws on a duplicate registerTool call.
export const CODE_ANALYSIS_TOOL_NAMES = [
	"gitlab_get_file_content",
	"gitlab_get_blame",
	"gitlab_get_commit_diff",
	"gitlab_list_commits",
	"gitlab_get_repository_tree",
	"gitlab_list_merge_requests",
] as const;

export function registerCodeAnalysisTools(server: McpServer, restClient: GitLabRestClient): number {
	registerGetFileContentTool(server, restClient);
	registerGetBlameTool(server, restClient);
	registerGetCommitDiffTool(server, restClient);
	registerListCommitsTool(server, restClient);
	registerGetRepositoryTreeTool(server, restClient);
	registerListMergeRequestsTool(server, restClient);
	log.info(
		{ count: CODE_ANALYSIS_TOOL_NAMES.length, tools: CODE_ANALYSIS_TOOL_NAMES },
		"Code analysis tools registered",
	);
	return CODE_ANALYSIS_TOOL_NAMES.length;
}

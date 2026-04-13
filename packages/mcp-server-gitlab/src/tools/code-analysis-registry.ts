// src/tools/code-analysis-registry.ts

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { GitLabRestClient } from "../gitlab-client/index.js";
import { registerGetBlameTool } from "./code-analysis/get-blame.js";
import { registerGetCommitDiffTool } from "./code-analysis/get-commit-diff.js";
import { registerGetFileContentTool } from "./code-analysis/get-file-content.js";
import { registerGetRepositoryTreeTool } from "./code-analysis/get-repository-tree.js";
import { registerListCommitsTool } from "./code-analysis/list-commits.js";

export function registerCodeAnalysisTools(server: McpServer, restClient: GitLabRestClient): number {
	registerGetFileContentTool(server, restClient);
	registerGetBlameTool(server, restClient);
	registerGetCommitDiffTool(server, restClient);
	registerListCommitsTool(server, restClient);
	registerGetRepositoryTreeTool(server, restClient);
	return 5;
}

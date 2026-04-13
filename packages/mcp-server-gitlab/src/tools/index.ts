// src/tools/index.ts

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { GitLabRestClient } from "../gitlab-client/index.js";
import type { GitLabMcpProxy } from "../gitlab-client/proxy.js";
import { createContextLogger } from "../utils/logger.js";
import { registerGetBlameTool } from "./code-analysis/get-blame.js";
import { registerGetCommitDiffTool } from "./code-analysis/get-commit-diff.js";
import { registerGetFileContentTool } from "./code-analysis/get-file-content.js";
import { registerGetRepositoryTreeTool } from "./code-analysis/get-repository-tree.js";
import { registerListCommitsTool } from "./code-analysis/list-commits.js";
import { registerProxyTools } from "./proxy/index.js";

const log = createContextLogger("tools");

export async function registerAllTools(
	server: McpServer,
	proxy: GitLabMcpProxy,
	restClient: GitLabRestClient,
): Promise<{ proxyTools: string[]; codeAnalysisTools: string[] }> {
	// Register proxied tools from GitLab's built-in MCP server
	let proxyTools: string[] = [];
	try {
		proxyTools = await registerProxyTools(server, proxy);
	} catch (error) {
		log.warn(
			{ error: error instanceof Error ? error.message : String(error) },
			"Failed to register proxy tools -- GitLab MCP endpoint may be unavailable. Code analysis tools will still work.",
		);
	}

	// Register custom code analysis tools via REST API
	const codeAnalysisTools: string[] = [];

	registerGetFileContentTool(server, restClient);
	codeAnalysisTools.push("gitlab_get_file_content");

	registerGetBlameTool(server, restClient);
	codeAnalysisTools.push("gitlab_get_blame");

	registerGetCommitDiffTool(server, restClient);
	codeAnalysisTools.push("gitlab_get_commit_diff");

	registerListCommitsTool(server, restClient);
	codeAnalysisTools.push("gitlab_list_commits");

	registerGetRepositoryTreeTool(server, restClient);
	codeAnalysisTools.push("gitlab_get_repository_tree");

	log.info(
		{
			proxyCount: proxyTools.length,
			codeAnalysisCount: codeAnalysisTools.length,
			totalCount: proxyTools.length + codeAnalysisTools.length,
		},
		"All tools registered",
	);

	return { proxyTools, codeAnalysisTools };
}

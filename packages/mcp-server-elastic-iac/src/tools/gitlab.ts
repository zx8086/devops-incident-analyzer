// src/tools/gitlab.ts
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Config } from "../config.ts";
import { gitlabFetch, text } from "./shared.ts";

// Repo reads + MR creation/inspection. gitlab_*_approve and gitlab_*_merge are
// intentionally absent (maker/checker separation of duties).
//
// Transport: GitLab REST (/api/v4) directly, so this server is self-contained and
// works against instances that do NOT expose GitLab's native MCP endpoint. Future
// end-state: switch these to the GitLab native MCP (the proxy pattern used by
// packages/mcp-server-gitlab) once the target instance supports it.
export function registerGitlabTools(server: McpServer, config: Config): void {
	const { gitlabBaseUrl, projectId } = config.repository;
	const token = config.gitlabToken;
	const project = encodeURIComponent(projectId);

	server.tool(
		"gitlab_get_repository_tree",
		"List files/directories in the IaC repo (defaults to the repository root).",
		{ path: z.string().optional(), ref: z.string().optional() },
		async ({ path, ref }) => {
			const qs = new URLSearchParams({ recursive: "false", per_page: "100" });
			if (path) qs.set("path", path);
			if (ref) qs.set("ref", ref);
			return text(await gitlabFetch(gitlabBaseUrl, token, `/projects/${project}/repository/tree?${qs}`));
		},
	);

	server.tool(
		"gitlab_get_file_content",
		"Read a Terraform file blob from the IaC repo.",
		{ filePath: z.string(), ref: z.string().optional() },
		async ({ filePath, ref }) => {
			const qs = new URLSearchParams({ ref: ref ?? "main" });
			return text(
				await gitlabFetch(
					gitlabBaseUrl,
					token,
					`/projects/${project}/repository/files/${encodeURIComponent(filePath)}?${qs}`,
				),
			);
		},
	);

	server.tool(
		"gitlab_create_merge_request",
		"Open a merge request from a working branch into main. Never merges or approves.",
		{
			source_branch: z.string(),
			target_branch: z.string(),
			title: z.string(),
			description: z.string(),
			labels: z.array(z.string()).optional(),
		},
		async ({ source_branch, target_branch, title, description, labels }) =>
			text(
				await gitlabFetch(gitlabBaseUrl, token, `/projects/${project}/merge_requests`, {
					method: "POST",
					body: JSON.stringify({
						source_branch,
						target_branch,
						title,
						description,
						labels: (labels ?? ["agent-generated", "iac"]).join(","),
						remove_source_branch: true,
						squash: true,
					}),
				}),
			),
	);

	server.tool("gitlab_get_merge_request", "Read a merge request by IID.", { iid: z.number() }, async ({ iid }) =>
		text(await gitlabFetch(gitlabBaseUrl, token, `/projects/${project}/merge_requests/${iid}`)),
	);

	server.tool(
		"gitlab_get_merge_request_pipelines",
		"List CI pipelines for a merge request (GitOps status; read-only).",
		{ iid: z.number() },
		async ({ iid }) =>
			text(await gitlabFetch(gitlabBaseUrl, token, `/projects/${project}/merge_requests/${iid}/pipelines`)),
	);
}

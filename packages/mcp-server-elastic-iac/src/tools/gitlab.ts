// src/tools/gitlab.ts
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Config } from "../config.ts";
import { gitlabFetch, text } from "./shared.ts";

// Build the POST /repository/commits body for a single-file content update.
// GitLab's "update" action needs the FULL new file content, not a diff. (Pure;
// unit-tested.)
export function buildCommitFileBody(input: {
	branch: string;
	commitMessage: string;
	filePath: string;
	content: string;
}): { branch: string; commit_message: string; actions: Array<{ action: string; file_path: string; content: string }> } {
	return {
		branch: input.branch,
		commit_message: input.commitMessage,
		actions: [{ action: "update", file_path: input.filePath, content: input.content }],
	};
}

// Repo reads + branch/commit/MR creation. gitlab_*_approve and gitlab_*_merge are
// intentionally absent (maker/checker separation of duties).
//
// Transport: GitLab REST (/api/v4) directly, so this server is self-contained and
// works against instances that do NOT expose GitLab's native MCP endpoint. Future
// end-state: switch these to the GitLab native MCP (the proxy pattern used by
// packages/mcp-server-gitlab) once the target instance supports it.
export function registerGitlabTools(server: McpServer, config: Config): void {
	// SIO-873: prefer the GitOps target (siobytes); fall back to repository.* so the
	// legacy read tools keep working when the GitOps vars are unset.
	const gitlabBaseUrl = config.gitops.baseUrl || config.repository.gitlabBaseUrl;
	const token = config.gitops.token ?? config.gitlabToken;
	const project = encodeURIComponent(config.gitops.project || config.repository.projectId);

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
		"gitlab_create_branch",
		"Create a branch from a ref (server-side; no local clone). GitOps proposer step before committing a config edit.",
		{ branch: z.string(), ref: z.string().optional() },
		async ({ branch, ref }) => {
			const qs = new URLSearchParams({ branch, ref: ref ?? "main" });
			return text(
				await gitlabFetch(gitlabBaseUrl, token, `/projects/${project}/repository/branches?${qs}`, {
					method: "POST",
				}),
			);
		},
	);

	server.tool(
		"gitlab_commit_file",
		"Commit a single-file content update to a branch via the GitLab API (server-side; no local git). The content is the FULL new file body, not a diff.",
		{
			branch: z.string(),
			file_path: z.string(),
			content: z.string().describe("Full new file content (read-modify-write; not a diff)."),
			commit_message: z.string(),
		},
		async ({ branch, file_path, content, commit_message }) =>
			text(
				await gitlabFetch(gitlabBaseUrl, token, `/projects/${project}/repository/commits`, {
					method: "POST",
					body: JSON.stringify(
						buildCommitFileBody({ branch, filePath: file_path, content, commitMessage: commit_message }),
					),
				}),
			),
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

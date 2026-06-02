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

// The repo's tf-report.jq shape (artifacts.reports.terraform): create/update/delete
// counts + the changed resources. This is what the MR Terraform widget consumes.
export interface TerraformReport {
	create: number;
	update: number;
	delete: number;
	resources: Array<{ address: string; actions: string[] }>;
}

// SIO-875: the repo runs a parent+child dynamic pipeline. The plan job (and its
// tfplan-report.json artifact) lives in the CHILD pipeline triggered by the parent's
// "deploy" bridge. These pure helpers walk the JSON responses; the tool chains the
// fetches. Exported for unit tests.

// First downstream (child) pipeline id from GET /pipelines/:id/bridges.
export function childPipelineId(bridgesJson: unknown): number | null {
	if (!Array.isArray(bridgesJson)) return null;
	for (const b of bridgesJson) {
		const dp = (b as { downstream_pipeline?: { id?: unknown } }).downstream_pipeline;
		if (dp && typeof dp.id === "number") return dp.id;
	}
	return null;
}

// The first plan job (name `plan:<deployment>:<stack>`) from GET /pipelines/:id/jobs,
// with the <stack> parsed out so the caller can build the artifact path.
export function planJob(jobsJson: unknown): { id: number; stack: string } | null {
	if (!Array.isArray(jobsJson)) return null;
	for (const j of jobsJson) {
		const name = (j as { name?: unknown }).name;
		const id = (j as { id?: unknown }).id;
		if (typeof name === "string" && name.startsWith("plan:") && typeof id === "number") {
			const stack = name.split(":")[2] ?? "";
			if (stack) return { id, stack };
		}
	}
	return null;
}

// Repo reads + branch/commit/MR creation + read-only CI/approval status.
// gitlab_*_approve and gitlab_*_merge are intentionally absent (maker/checker SoD).
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

	// JSON variant of gitlabFetch for the multi-hop terraform-report walk. Throws on
	// missing token / non-2xx so the chaining handler can branch.
	async function glJson(apiPath: string): Promise<unknown> {
		if (!token) throw new Error("gitlab token not configured: set ELASTIC_IAC_GITLAB_TOKEN");
		const res = await fetch(`${gitlabBaseUrl}/api/v4${apiPath}`, { headers: { "PRIVATE-TOKEN": token } });
		if (!res.ok) throw new Error(`[${res.status}] ${await res.text()}`);
		return res.json();
	}

	server.tool(
		"gitlab_get_pipeline",
		"Read a single pipeline's status (read-only GitOps status). Use the id from gitlab_get_merge_request_pipelines.",
		{ pipelineId: z.number() },
		async ({ pipelineId }) =>
			text(await gitlabFetch(gitlabBaseUrl, token, `/projects/${project}/pipelines/${pipelineId}`)),
	);

	server.tool(
		"gitlab_get_pipeline_terraform_report",
		"Get the actual Terraform plan (create/update/delete + changed resources) for an MR pipeline. " +
			"Walks the parent->child dynamic pipeline to the plan job's tfplan-report.json artifact. Read-only.",
		{ pipelineId: z.number().describe("Parent (MR) pipeline id from gitlab_get_merge_request_pipelines.") },
		async ({ pipelineId }) => {
			try {
				const childId = childPipelineId(await glJson(`/projects/${project}/pipelines/${pipelineId}/bridges`));
				if (childId === null) return text("[no child pipeline yet -- the deploy stage has not triggered the plan]");
				const job = planJob(await glJson(`/projects/${project}/pipelines/${childId}/jobs`));
				if (!job) return text("[no plan job found in the child pipeline yet]");
				// Artifact is stacks/<stack>/tfplan-report.json (raw, not [status]-wrapped).
				const report = (await glJson(
					`/projects/${project}/jobs/${job.id}/artifacts/stacks/${job.stack}/tfplan-report.json`,
				)) as TerraformReport;
				return text(JSON.stringify(report, null, 2));
			} catch (err) {
				return text(`[terraform report not available: ${err instanceof Error ? err.message : String(err)}]`);
			}
		},
	);

	const PLAN_LOG_TAIL_BYTES = 4000;
	server.tool(
		"gitlab_get_pipeline_plan_log",
		"Get the tail of the plan job's log for an MR pipeline (to diagnose a FAILED plan -- e.g. a " +
			"Terraform state-lock vs a real plan error). Walks the parent->child pipeline to the plan job. Read-only.",
		{ pipelineId: z.number().describe("Parent (MR) pipeline id from gitlab_get_merge_request_pipelines.") },
		async ({ pipelineId }) => {
			if (!token) return text("[gitlab token not configured: set ELASTIC_IAC_GITLAB_TOKEN]");
			try {
				const childId = childPipelineId(await glJson(`/projects/${project}/pipelines/${pipelineId}/bridges`));
				if (childId === null) return text("[no child pipeline yet]");
				const job = planJob(await glJson(`/projects/${project}/pipelines/${childId}/jobs`));
				if (!job) return text("[no plan job found in the child pipeline]");
				const res = await fetch(`${gitlabBaseUrl}/api/v4/projects/${project}/jobs/${job.id}/trace`, {
					headers: { "PRIVATE-TOKEN": token },
				});
				if (!res.ok) return text(`[${res.status}] could not read the plan job log`);
				const trace = await res.text();
				return text(trace.length > PLAN_LOG_TAIL_BYTES ? trace.slice(-PLAN_LOG_TAIL_BYTES) : trace);
			} catch (err) {
				return text(`[plan log not available: ${err instanceof Error ? err.message : String(err)}]`);
			}
		},
	);

	server.tool(
		"gitlab_get_merge_request_approvals",
		"Read a merge request's approval state (approved? by whom? required count). Read-only; never approves.",
		{ iid: z.number() },
		async ({ iid }) =>
			text(await gitlabFetch(gitlabBaseUrl, token, `/projects/${project}/merge_requests/${iid}/approvals`)),
	);

	server.tool(
		"gitlab_list_agent_merge_requests",
		"List the agent's open merge requests (label agent-generated), newest first. Used to recover " +
			"the MR to watch when the thread no longer holds it (e.g. after a page reload). Read-only.",
		{},
		async () =>
			text(
				await gitlabFetch(
					gitlabBaseUrl,
					token,
					`/projects/${project}/merge_requests?labels=agent-generated&state=opened&order_by=created_at&sort=desc&per_page=10`,
				),
			),
	);
}

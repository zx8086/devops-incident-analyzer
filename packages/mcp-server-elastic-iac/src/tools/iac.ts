// src/tools/iac.ts
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Config } from "../config.ts";
import { run, text } from "./shared.ts";

// Read-only wrappers around the IaC repo's Task helper verbs -- the same
// `task <verb> STACK=.. DEPLOYMENT=..` entry points operators use. status / list /
// output / state-list only read. Mutating verbs (apply, destroy, import, and state
// surgery: state-mv / state-rm) are deliberately absent; CI owns mutation behind the
// human gate. Status and inspection never require drafting a change.
export function registerIacTools(server: McpServer, config: Config): void {
	const cwd = config.repository.workspaceDir;
	const task = config.taskBin;

	server.tool(
		"iac_status",
		"Reconcile status across deployments via the repo's `task status` helper. Read-only.",
		{ deployment: z.string().optional().describe("Limit to one deployment, e.g. eu-b2b") },
		async ({ deployment }) =>
			text(await run([task, "status", ...(deployment ? [`DEPLOYMENT=${deployment}`] : [])], cwd)),
	);

	server.tool(
		"iac_list_stacks",
		"List the stacks the IaC repo manages (`task list-stacks`). Read-only.",
		{},
		async () => text(await run([task, "list-stacks"], cwd)),
	);

	server.tool(
		"iac_list_deployments",
		"List the Elastic Cloud deployments the IaC repo manages (`task list-deployments`). Read-only.",
		{},
		async () => text(await run([task, "list-deployments"], cwd)),
	);

	server.tool(
		"iac_output",
		"Surface a stack's Terraform outputs (IDs/endpoints) via `task output`. Read-only.",
		{
			stack: z.string().describe("Stack name, e.g. slos, lifecycle-policies"),
			deployment: z.string().describe("Deployment name, e.g. eu-b2b"),
		},
		async ({ stack, deployment }) =>
			text(await run([task, "output", `STACK=${stack}`, `DEPLOYMENT=${deployment}`], cwd)),
	);

	server.tool(
		"iac_state_list",
		"List the resources a stack currently owns in state (`task state-list`). Read-only.",
		{
			stack: z.string().describe("Stack name, e.g. slos, lifecycle-policies"),
			deployment: z.string().describe("Deployment name, e.g. eu-b2b"),
		},
		async ({ stack, deployment }) =>
			text(await run([task, "state-list", `STACK=${stack}`, `DEPLOYMENT=${deployment}`], cwd)),
	);
}

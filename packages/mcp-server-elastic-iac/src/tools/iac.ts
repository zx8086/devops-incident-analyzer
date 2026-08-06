// src/tools/iac.ts
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Config } from "../config.ts";
import { run, text } from "./shared.ts";
import { iacToolAnnotations } from "./tool-classification.ts";

// Read-only wrappers around the IaC repo's Task helper verbs -- the same
// `task <verb> STACK=.. DEPLOYMENT=..` entry points operators use. status / list /
// output / state-list only read. Mutating verbs (apply, destroy, import, and state
// surgery: state-mv / state-rm) are deliberately absent; CI owns mutation behind the
// human gate. Status and inspection never require drafting a change.

// SIO-869: stack/deployment names flow into `task` argv (STACK=.., DEPLOYMENT=..).
// run() uses Bun.spawn with an argv array (no shell), so there is no metacharacter
// injection vector -- this constraint just rejects empty/malformed names early with a
// clear validation error rather than spawning task with a bogus arg.
const ident = z
	.string()
	.min(1)
	.regex(/^[A-Za-z0-9._-]+$/);

export function registerIacTools(server: McpServer, config: Config): void {
	const cwd = config.repository.workspaceDir;
	const task = config.taskBin;

	server.registerTool(
		"iac_status",
		{
			description: "Reconcile status across deployments via the repo's `task status` helper. Read-only.",
			inputSchema: { deployment: ident.optional().describe("Limit to one deployment, e.g. eu-b2b") },
			annotations: iacToolAnnotations("iac_status"),
		},
		async ({ deployment }) =>
			text(await run([task, "status", ...(deployment ? [`DEPLOYMENT=${deployment}`] : [])], cwd)),
	);

	server.registerTool(
		"iac_list_stacks",
		{
			description: "List the stacks the IaC repo manages (`task list-stacks`). Read-only.",
			inputSchema: {},
			annotations: iacToolAnnotations("iac_list_stacks"),
		},
		async () => text(await run([task, "list-stacks"], cwd)),
	);

	server.registerTool(
		"iac_list_deployments",
		{
			description: "List the Elastic Cloud deployments the IaC repo manages (`task list-deployments`). Read-only.",
			inputSchema: {},
			annotations: iacToolAnnotations("iac_list_deployments"),
		},
		async () => text(await run([task, "list-deployments"], cwd)),
	);

	server.registerTool(
		"iac_output",
		{
			description: "Surface a stack's Terraform outputs (IDs/endpoints) via `task output`. Read-only.",
			inputSchema: {
				stack: ident.describe("Stack name, e.g. slos, lifecycle-policies"),
				deployment: ident.describe("Deployment name, e.g. eu-b2b"),
			},
			annotations: iacToolAnnotations("iac_output"),
		},
		async ({ stack, deployment }) =>
			text(await run([task, "output", `STACK=${stack}`, `DEPLOYMENT=${deployment}`], cwd)),
	);

	server.registerTool(
		"iac_state_list",
		{
			description: "List the resources a stack currently owns in state (`task state-list`). Read-only.",
			inputSchema: {
				stack: ident.describe("Stack name, e.g. slos, lifecycle-policies"),
				deployment: ident.describe("Deployment name, e.g. eu-b2b"),
			},
			annotations: iacToolAnnotations("iac_state_list"),
		},
		async ({ stack, deployment }) =>
			text(await run([task, "state-list", `STACK=${stack}`, `DEPLOYMENT=${deployment}`], cwd)),
	);
}

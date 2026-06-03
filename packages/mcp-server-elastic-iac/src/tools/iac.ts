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

// SIO-869: stack/deployment names flow into `task` argv (STACK=.., DEPLOYMENT=..).
// run() uses Bun.spawn with an argv array (no shell), so there is no metacharacter
// injection vector -- this constraint just rejects empty/malformed names early with a
// clear validation error rather than spawning task with a bogus arg.
const ident = z
	.string()
	.min(1)
	.regex(/^[A-Za-z0-9._-]+$/);

// The tfplan-report.json shape the CI plan job emits (create/update/delete counts +
// the changed resources). iac_plan returns this so the agent's drift report and the
// MR pipeline's terraform report parse identically.
export interface StackPlanCounts {
	create: number;
	update: number;
	delete: number;
	resources: Array<{ address: string; actions: string[] }>;
}

// Parse a `task plan` transcript into structured counts, tolerant of either machine
// output (the repo's tfplan-report JSON shape) or terraform's human summary. run()
// appends "\n[exit N]"; strip it before structured parsing. Returns null when the
// output matches no known shape (the tool surfaces a parseError to the agent). Pure;
// unit-tested. (SIO-882)
export function parsePlanTranscript(transcript: string): StackPlanCounts | null {
	const body = transcript.replace(/\n?\[exit -?\d+\]\s*$/, "").trim();

	// 1. Machine output: the body is (or begins with) the tfplan-report JSON object.
	const jsonStart = body.indexOf("{");
	if (jsonStart >= 0) {
		try {
			const r = JSON.parse(body.slice(jsonStart)) as Partial<StackPlanCounts>;
			if (typeof r.create === "number" && typeof r.update === "number" && typeof r.delete === "number") {
				return {
					create: r.create,
					update: r.update,
					delete: r.delete,
					resources: Array.isArray(r.resources) ? r.resources : [],
				};
			}
		} catch {
			// not pure JSON -- fall through to the human-summary parse
		}
	}

	// 2. Terraform's human summary line: "Plan: 1 to add, 2 to change, 3 to destroy."
	const m = body.match(/Plan:\s*(\d+)\s+to add,\s*(\d+)\s+to change,\s*(\d+)\s+to destroy/i);
	if (m) return { create: Number(m[1]), update: Number(m[2]), delete: Number(m[3]), resources: [] };

	// 3. Explicit no-changes phrasing.
	if (/no changes|matches the configuration/i.test(body)) return { create: 0, update: 0, delete: 0, resources: [] };

	return null;
}

export function registerIacTools(server: McpServer, config: Config): void {
	const cwd = config.repository.workspaceDir;
	const task = config.taskBin;

	server.tool(
		"iac_status",
		"Reconcile status across deployments via the repo's `task status` helper. Read-only.",
		{ deployment: ident.optional().describe("Limit to one deployment, e.g. eu-b2b") },
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
			stack: ident.describe("Stack name, e.g. slos, lifecycle-policies"),
			deployment: ident.describe("Deployment name, e.g. eu-b2b"),
		},
		async ({ stack, deployment }) =>
			text(await run([task, "output", `STACK=${stack}`, `DEPLOYMENT=${deployment}`], cwd)),
	);

	server.tool(
		"iac_state_list",
		"List the resources a stack currently owns in state (`task state-list`). Read-only.",
		{
			stack: ident.describe("Stack name, e.g. slos, lifecycle-policies"),
			deployment: ident.describe("Deployment name, e.g. eu-b2b"),
		},
		async ({ stack, deployment }) =>
			text(await run([task, "state-list", `STACK=${stack}`, `DEPLOYMENT=${deployment}`], cwd)),
	);

	// SIO-882: structured per-stack drift for the reconcile flow. Runs the repo's
	// read-only `task plan` (terraform plan, never apply) and returns the tfplan-report
	// shape so the agent can build a per-stack drift report and route the per-stack
	// reconcile choice. JSON=1 is a hint for repos whose plan verb can emit the JSON
	// report; it is a harmless no-op var otherwise -- parsePlanTranscript also reads
	// terraform's human summary. Read-only: this server never applies.
	server.tool(
		"iac_plan",
		"Structured Terraform drift for one stack of one deployment, as {stack,deployment,drifted,create,update,delete,resources[]} " +
			"(the tfplan-report.json shape). Runs the repo's read-only `task plan`; never applies. Use to detect content drift per stack.",
		{
			stack: ident.describe("Stack name, e.g. deployments, lifecycle-policies"),
			deployment: ident.describe("Deployment name, e.g. gl-testing"),
		},
		async ({ stack, deployment }) => {
			const transcript = await run([task, "plan", `STACK=${stack}`, `DEPLOYMENT=${deployment}`, "JSON=1"], cwd);
			const counts = parsePlanTranscript(transcript);
			if (!counts) {
				return text(
					JSON.stringify({ stack, deployment, drifted: false, parseError: true, tail: transcript.slice(-600) }),
				);
			}
			const drifted = counts.create + counts.update + counts.delete > 0;
			return text(JSON.stringify({ stack, deployment, drifted, ...counts }));
		},
	);
}

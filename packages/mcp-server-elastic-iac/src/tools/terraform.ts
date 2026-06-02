// src/tools/terraform.ts
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Config } from "../config.ts";
import { run, text } from "./shared.ts";

// fmt/validate/plan/search only. apply, destroy, state surgery, and force-unlock
// are intentionally not registered -- CI runs the authoritative apply behind a
// human gate.
export function registerTerraformTools(server: McpServer, config: Config): void {
	const cwd = config.repository.workspaceDir;
	const tf = config.terraformBin;

	server.tool(
		"terraform_fmt",
		"Check Terraform formatting (terraform fmt -check -diff). Does not write files.",
		{ path: z.string().optional().describe("Optional subdirectory under the workspace") },
		async ({ path }) => text(await run([tf, "fmt", "-check", "-diff", ...(path ? [path] : [])], cwd)),
	);

	server.tool(
		"terraform_validate",
		"Validate the Terraform configuration in the workspace (terraform validate).",
		{},
		async () => text(await run([tf, "validate", "-no-color"], cwd)),
	);

	server.tool(
		"terraform_plan",
		"Run terraform plan for local sanity-check of module syntax. Read-only; never applies.",
		{ cluster: z.string().optional().describe("Target cluster/stack, for logging only") },
		async () => text(await run([tf, "plan", "-no-color", "-input=false"], cwd)),
	);

	server.tool(
		"terraform_search_modules",
		"Search the public Terraform Registry for modules.",
		{ query: z.string().describe("Search term, e.g. 'elasticstack ilm'") },
		async ({ query }) => text(await searchRegistry("modules", query)),
	);

	server.tool(
		"terraform_search_providers",
		"Search the public Terraform Registry for providers.",
		{ query: z.string().describe("Search term, e.g. 'elasticstack'") },
		async ({ query }) => text(await searchRegistry("providers", query)),
	);
}

async function searchRegistry(kind: "modules" | "providers", query: string): Promise<string> {
	try {
		const res = await fetch(`https://registry.terraform.io/v1/${kind}/search?q=${encodeURIComponent(query)}&limit=5`);
		return `[${res.status}] ${await res.text()}`;
	} catch (err) {
		return `[registry search failed: ${err instanceof Error ? err.message : String(err)}]`;
	}
}

// src/tools/terraform.ts
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Config } from "../config.ts";
import { text } from "./shared.ts";
import { iacToolAnnotations } from "./tool-classification.ts";

// SIO-912: registry search only. terraform fmt/validate/plan shelled out to a local
// `terraform` binary against a local clone -- a path the agent no longer takes (it is a
// propose-only GitOps maker: edit config + open an MR; CI computes the authoritative plan
// on the MR, deck slide 18). apply/destroy/state-surgery/force-unlock were never registered.
export function registerTerraformTools(server: McpServer, _config: Config): void {
	server.registerTool(
		"terraform_search_modules",
		{
			description: "Search the public Terraform Registry for modules.",
			inputSchema: { query: z.string().describe("Search term, e.g. 'elasticstack ilm'") },
			annotations: iacToolAnnotations("terraform_search_modules"),
		},
		async ({ query }) => text(await searchRegistry("modules", query)),
	);

	server.registerTool(
		"terraform_search_providers",
		{
			description: "Search the public Terraform Registry for providers.",
			inputSchema: { query: z.string().describe("Search term, e.g. 'elasticstack'") },
			annotations: iacToolAnnotations("terraform_search_providers"),
		},
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

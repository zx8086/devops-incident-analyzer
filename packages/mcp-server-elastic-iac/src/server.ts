// src/server.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import pkg from "../package.json" with { type: "json" };
import type { Config } from "./config.ts";
import { registerElasticTools } from "./tools/elastic.ts";
import { registerGitlabTools } from "./tools/gitlab.ts";
import { registerIacTools } from "./tools/iac.ts";
import { registerTerraformTools } from "./tools/terraform.ts";

export function createServer(config: Config): McpServer {
	const server = new McpServer({
		name: "elastic-iac-mcp-server",
		version: pkg.version,
		// SIO-912: propose-only GitOps maker. The agent edits config + opens a GitLab MR via
		// the GitLab REST API; CI computes the Terraform plan on the MR and a human merges/
		// applies. The local-terraform (fmt/validate/plan) and local-git (clone/branch/commit/
		// push) tools were retired -- only the Terraform Registry search remains.
		description:
			"Elastic Cloud IaC maker tools: GitLab MR open/read + drift/synthetics triggers, read-only Elastic Cloud/cluster state, read-only IaC status/inspect helpers (task status/list/output/state-list), and Terraform Registry search. Never runs terraform, never applies, merges, or approves.",
	});

	registerTerraformTools(server, config);
	registerGitlabTools(server, config);
	registerElasticTools(server, config);
	registerIacTools(server, config);

	return server;
}

// src/server.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import pkg from "../package.json" with { type: "json" };
import type { Config } from "./config.ts";
import { registerElasticTools } from "./tools/elastic.ts";
import { registerGitTools } from "./tools/git.ts";
import { registerGitlabTools } from "./tools/gitlab.ts";
import { registerIacTools } from "./tools/iac.ts";
import { registerTerraformTools } from "./tools/terraform.ts";

export function createServer(config: Config): McpServer {
	const server = new McpServer({
		name: "elastic-iac-mcp-server",
		version: pkg.version,
		description:
			"Elastic Cloud IaC maker tools: terraform fmt/validate/plan, git branch/commit/push (non-protected), GitLab MR open/read, read-only Elastic Cloud/cluster state, and read-only IaC status/inspect helpers (task status/list/output/state-list). Never applies, merges, or approves.",
	});

	registerTerraformTools(server, config);
	registerGitTools(server, config);
	registerGitlabTools(server, config);
	registerElasticTools(server, config);
	registerIacTools(server, config);

	return server;
}

// src/server.ts
import { createCachedServerFactory } from "@devops-agent/shared";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import pkg from "../package.json" with { type: "json" };
import type { Config } from "./config.ts";
import { registerElasticTools } from "./tools/elastic.ts";
import { registerGitlabTools } from "./tools/gitlab.ts";
import { registerIacTools } from "./tools/iac.ts";
import { registerTerraformTools } from "./tools/terraform.ts";

// Sync -- allocates a bare McpServer with capabilities/description but NO tools.
function createBareServer(): McpServer {
	return new McpServer({
		name: "elastic-iac-mcp-server",
		version: pkg.version,
		// SIO-912: propose-only GitOps maker. The agent edits config + opens a GitLab MR via
		// the GitLab REST API; CI computes the Terraform plan on the MR and a human merges/
		// applies. The local-terraform (fmt/validate/plan) and local-git (clone/branch/commit/
		// push) tools were retired -- only the Terraform Registry search remains.
		description:
			"Elastic Cloud IaC maker tools: GitLab MR open/read + drift/synthetics triggers, read-only Elastic Cloud/cluster state, read-only IaC status/inspect helpers (task status/list/output/state-list), and Terraform Registry search. Never runs terraform, never applies, merges, or approves.",
	});
}

function registerAll(server: McpServer, config: Config): void {
	registerTerraformTools(server, config);
	registerGitlabTools(server, config);
	registerElasticTools(server, config);
	registerIacTools(server, config);
}

// SIO-1044: record-once / replay-many factory. registerAll (sync, config-only) runs ONCE at
// boot; each request replays the recorded tool triples onto a fresh bare server.
export function createMcpServerFactory(config: Config): () => McpServer {
	return createCachedServerFactory({
		createBareServer: () => createBareServer(),
		registerAll: (server) => registerAll(server, config),
	});
}

// Sync -- creates a fresh McpServer and registers all tools on it. Kept for back-compat
// (src/server.test.ts + any caller that wants a one-off instance without the factory).
export function createServer(config: Config): McpServer {
	const server = createBareServer();
	registerAll(server, config);
	return server;
}

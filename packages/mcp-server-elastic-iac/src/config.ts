// src/config.ts
import { z } from "zod";

// Per project rules, no .default() inside the schema; the loader supplies explicit
// env fallbacks. The server is read/plan/branch-only -- it has no apply/destroy knobs.
export const ConfigSchema = z.object({
	transport: z.object({
		mode: z.enum(["http", "stdio"]),
		port: z.number().int().positive(),
		host: z.string(),
		path: z.string(),
	}),
	repository: z.object({
		// GitLab REST base for the IaC repo (MRs, file blobs, repository tree).
		gitlabBaseUrl: z.string(),
		projectId: z.string(),
		// Local clone the git/terraform tools operate inside (never the agent's CWD).
		workspaceDir: z.string(),
	}),
	// SIO-873: the GitOps target the agent proposes against (edit JSON + open MR via
	// the GitLab REST API; CI owns plan/apply). A self-hosted instance distinct from
	// repository.* above. The agent never clones, never runs terraform, never pushes.
	gitops: z.object({
		baseUrl: z.string(),
		// Namespaced project path (e.g. "siobytes/elastic-iac"); GitLab accepts it
		// URL-encoded in place of a numeric id.
		project: z.string(),
		token: z.string().optional(),
	}),
	terraformBin: z.string(),
	// Task runner for the repo's read-only helper verbs (status/list/output/state-list).
	taskBin: z.string(),
	// Optional credentials; tools degrade with a clear message when absent.
	gitlabToken: z.string().optional(),
	elasticCloudApiKey: z.string().optional(),
	elasticCloudBaseUrl: z.string(),
});

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(): Config {
	return ConfigSchema.parse({
		transport: {
			mode: (Bun.env.ELASTIC_IAC_MCP_TRANSPORT as "http" | "stdio") ?? "http",
			port: Number(Bun.env.ELASTIC_IAC_MCP_PORT ?? "9086"),
			host: Bun.env.ELASTIC_IAC_MCP_HOST ?? "0.0.0.0",
			path: Bun.env.ELASTIC_IAC_MCP_PATH ?? "/mcp",
		},
		repository: {
			gitlabBaseUrl: Bun.env.GITLAB_BASE_URL ?? "https://gitlab.com",
			projectId: Bun.env.ELASTIC_IAC_GITLAB_PROJECT_ID ?? "71488350",
			workspaceDir: Bun.env.ELASTIC_IAC_WORKSPACE_DIR ?? "/tmp/elastic-iac-workspace",
		},
		gitops: {
			baseUrl: Bun.env.ELASTIC_IAC_GITLAB_BASE_URL ?? "https://gitlab.siobytes.cloud",
			project: Bun.env.ELASTIC_IAC_GITLAB_PROJECT ?? "siobytes/elastic-iac",
			token: Bun.env.ELASTIC_IAC_GITLAB_TOKEN || undefined,
		},
		terraformBin: Bun.env.TERRAFORM_BIN ?? "terraform",
		taskBin: Bun.env.ELASTIC_IAC_TASK_BIN ?? "task",
		gitlabToken: Bun.env.GITLAB_PERSONAL_ACCESS_TOKEN || undefined,
		elasticCloudApiKey: Bun.env.EC_API_KEY || undefined,
		elasticCloudBaseUrl: Bun.env.ELASTIC_CLOUD_BASE_URL ?? "https://api.elastic-cloud.com",
	});
}

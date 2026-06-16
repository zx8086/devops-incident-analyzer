// src/config.ts
import { z } from "zod";

// Per-deployment ES data-plane (cluster API) connection, used by the read-only cluster tools
// (ILM / index-template / health) the drift flow needs for reconcile-to-live. Distinct from the
// EC control-plane (elasticCloudApiKey/elasticCloudBaseUrl above). Auth is apiKey OR
// username+password OR none -- the three are mutually exclusive, since resolveCluster() prefers
// apiKey and would silently ignore a co-supplied username/password. Mirrors mcp-server-elastic's
// DeploymentConfigSchema.
export const ClusterDeploymentSchema = z
	.object({
		id: z.string().min(1),
		url: z.string().url().min(1),
		apiKey: z.string().optional(),
		username: z.string().optional(),
		password: z.string().optional(),
	})
	.superRefine((d, ctx) => {
		const hasApiKey = !!d.apiKey;
		const hasUsername = !!d.username;
		const hasPassword = !!d.password;
		if (hasUsername !== hasPassword) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: "Cluster basic auth requires both username and password",
				path: hasUsername ? ["password"] : ["username"],
			});
		}
		if (hasApiKey && (hasUsername || hasPassword)) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: "Cluster auth must use either apiKey or username+password, not both",
				path: ["apiKey"],
			});
		}
	});

export type ClusterDeployment = z.infer<typeof ClusterDeploymentSchema>;

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
		// Working dir the read-only `task` helper tools (iac.ts: status/list/output/state-list)
		// run inside. SIO-912: no longer a terraform/git clone -- those local tools were retired.
		workspaceDir: z.string(),
	}),
	// SIO-873: the GitOps target the agent proposes against (edit JSON + open MR via
	// the GitLab REST API; CI owns plan/apply). SIO-891: now the same instance as
	// repository.* (gitlab.com) after the migration off gitlab.siobytes.cloud, but kept
	// as separate vars so the target can diverge again. The agent never clones, never
	// runs terraform, never pushes.
	gitops: z.object({
		baseUrl: z.string(),
		// Namespaced project path (e.g. "pvhcorp/dhco/observability/observability-elastic-iac");
		// GitLab accepts it URL-encoded in place of a numeric id.
		project: z.string(),
		token: z.string().optional(),
	}),
	// Task runner for the repo's read-only helper verbs (status/list/output/state-list).
	taskBin: z.string(),
	// Optional credentials; tools degrade with a clear message when absent.
	gitlabToken: z.string().optional(),
	elasticCloudApiKey: z.string().optional(),
	elasticCloudBaseUrl: z.string(),
	// Per-deployment cluster (data-plane) connections, keyed by cluster name (the drift flow's
	// targetDeployment). Empty when none configured -- cluster reads then return a clear "not
	// configured" placeholder, and ILM reconcile-to-live blocks instead of guessing.
	clusterDeployments: z.array(ClusterDeploymentSchema),
});

export type Config = z.infer<typeof ConfigSchema>;

// Per-deployment cluster env convention: ELASTIC_IAC_CLUSTER_<ID_UPPER_UNDERSCORED>_<SUFFIX>
// (URL / API_KEY / USERNAME / PASSWORD), with the id list in ELASTIC_IAC_CLUSTER_DEPLOYMENTS.
// Mirrors mcp-server-elastic's deployments loader. A deployment with no URL is skipped (one
// misconfigured cluster never blocks the others).
function clusterEnvKey(id: string, suffix: string): string {
	return `ELASTIC_IAC_CLUSTER_${id.toUpperCase().replace(/-/g, "_")}_${suffix}`;
}
function readClusterEnv(id: string, suffix: string): string | undefined {
	const v = Bun.env[clusterEnvKey(id, suffix)];
	return v && v.length > 0 ? v : undefined;
}
function loadClusterDeployments(): ClusterDeployment[] {
	const raw = Bun.env.ELASTIC_IAC_CLUSTER_DEPLOYMENTS;
	if (!raw) return [];
	const out: ClusterDeployment[] = [];
	for (const id of raw
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean)) {
		const url = readClusterEnv(id, "URL");
		if (!url) continue;
		out.push({
			id,
			url,
			apiKey: readClusterEnv(id, "API_KEY"),
			username: readClusterEnv(id, "USERNAME"),
			password: readClusterEnv(id, "PASSWORD"),
		});
	}
	return out;
}

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
			projectId: Bun.env.ELASTIC_IAC_GITLAB_PROJECT_ID ?? "82850717",
			workspaceDir: Bun.env.ELASTIC_IAC_WORKSPACE_DIR ?? "/tmp/elastic-iac-workspace",
		},
		gitops: {
			baseUrl: Bun.env.ELASTIC_IAC_GITLAB_BASE_URL ?? "https://gitlab.com",
			project: Bun.env.ELASTIC_IAC_GITLAB_PROJECT ?? "pvhcorp/dhco/observability/observability-elastic-iac",
			token: Bun.env.ELASTIC_IAC_GITLAB_TOKEN || undefined,
		},
		taskBin: Bun.env.ELASTIC_IAC_TASK_BIN ?? "task",
		gitlabToken: Bun.env.GITLAB_PERSONAL_ACCESS_TOKEN || undefined,
		elasticCloudApiKey: Bun.env.EC_API_KEY || undefined,
		elasticCloudBaseUrl: Bun.env.ELASTIC_CLOUD_BASE_URL ?? "https://api.elastic-cloud.com",
		clusterDeployments: loadClusterDeployments(),
	});
}

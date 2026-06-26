// src/tools/elastic.ts
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ClusterDeployment, Config } from "../config.ts";
import { text } from "./shared.ts";

// Shapes of the slices of the Elastic Cloud deployment payloads this server reads.
// The two endpoints differ: the LIST (/api/v1/deployments) gives `resources[]`
// entries tagged with `kind`, carrying name/id/region but NEITHER version NOR
// health; the per-deployment GET gives `resources.elasticsearch[]` whose `info`
// holds health and `plan_info.current.plan.elasticsearch.version`. So version
// always requires a per-id GET (the fan-out below).

// LIST row: deployments[].resources[] where kind === "elasticsearch".
interface ListResource {
	kind?: string;
	region?: string;
}
interface ListRow {
	id?: string;
	name?: string;
	resources?: ListResource[];
}
export interface DeploymentVersion {
	name: string;
	id: string;
	version: string;
	region: string;
	healthy: boolean | null;
}

// GET body: resources.elasticsearch[].info.{healthy, plan_info.current.plan.elasticsearch.version}.
interface GetEsResource {
	region?: string;
	info?: {
		healthy?: boolean;
		plan_info?: { current?: { plan?: { elasticsearch?: { version?: string } } } };
	};
}

// Narrow the /api/v1/deployments list envelope to its rows.
export function asDeploymentRows(v: unknown): ListRow[] {
	if (typeof v === "object" && v !== null && "deployments" in v) {
		const d = (v as { deployments?: unknown }).deployments;
		if (Array.isArray(d)) return d as ListRow[];
	}
	return [];
}

// Pull name/id/region from a LIST row. version stays "" / healthy null -- the list
// endpoint never carries them, so the caller enriches via a per-id GET.
export function extractListRow(row: ListRow): DeploymentVersion {
	const es = (row.resources ?? []).find((r) => r.kind === "elasticsearch");
	return {
		name: row.name ?? "(unnamed)",
		id: row.id ?? "",
		version: "",
		region: es?.region ?? "",
		healthy: null,
	};
}

// Pull the version + health (+ region fallback) from a per-deployment GET body.
export function extractDeploymentDetail(getBody: unknown): {
	version: string;
	healthy: boolean | null;
	region: string;
} {
	const es =
		typeof getBody === "object" && getBody !== null
			? ((getBody as { resources?: { elasticsearch?: GetEsResource[] } }).resources?.elasticsearch?.[0] ?? null)
			: null;
	return {
		version: es?.info?.plan_info?.current?.plan?.elasticsearch?.version ?? "",
		healthy: es?.info?.healthy ?? null,
		region: es?.region ?? "",
	};
}

// Read-only Elastic Cloud + cluster reads to ground a change before drafting.
// No put/update/delete: the agent observes; Terraform (via CI) mutates.
export function registerElasticTools(server: McpServer, config: Config): void {
	const base = config.elasticCloudBaseUrl;
	const key = config.elasticCloudApiKey;

	async function cloudFetch(apiPath: string): Promise<string> {
		if (!key) return "[elastic cloud api key not configured: set EC_API_KEY]";
		try {
			const res = await fetch(`${base}${apiPath}`, { headers: { Authorization: `ApiKey ${key}` } });
			return `[${res.status}] ${await res.text()}`;
		} catch (err) {
			return `[elastic cloud request failed: ${err instanceof Error ? err.message : String(err)}]`;
		}
	}

	// JSON variant of cloudFetch: returns the parsed body, throws on missing key
	// or non-2xx so aggregating handlers can branch on success/failure.
	async function cloudJson(apiPath: string): Promise<unknown> {
		if (!key) throw new Error("elastic cloud api key not configured: set EC_API_KEY");
		const res = await fetch(`${base}${apiPath}`, { headers: { Authorization: `ApiKey ${key}` } });
		if (!res.ok) throw new Error(`[${res.status}] ${await res.text()}`);
		return res.json();
	}

	server.tool("elastic_cloud_list_deployments", "List Elastic Cloud deployments.", {}, async () =>
		text(await cloudFetch("/api/v1/deployments")),
	);

	// Bound the per-id GETs used to enrich sparse list rows with a version.
	const MAX_VERSION_FANOUT = 25;
	server.tool(
		"elastic_cloud_list_deployment_versions",
		"List all Elastic Cloud deployments with their Elasticsearch version, region, and health (one row per deployment). " +
			"Org-scoped; answers 'what version is X running' across one or many deployments without drafting any change. " +
			`Sparse list rows are enriched with a bounded per-deployment lookup (max ${MAX_VERSION_FANOUT}).`,
		{
			nameFilter: z
				.string()
				.optional()
				.describe("Case-insensitive substring filter on deployment name; omit for all org deployments."),
		},
		async ({ nameFilter }) => {
			try {
				const rows = asDeploymentRows(await cloudJson("/api/v1/deployments"));
				const filtered = nameFilter
					? rows.filter((r) => (r.name ?? "").toLowerCase().includes(nameFilter.toLowerCase()))
					: rows;

				const out: DeploymentVersion[] = [];
				let fanouts = 0;
				for (const row of filtered) {
					const entry = extractListRow(row);
					// Version + health live only on the per-deployment GET; enrich within budget.
					if (entry.id && fanouts < MAX_VERSION_FANOUT) {
						fanouts++;
						try {
							const detail = extractDeploymentDetail(await cloudJson(`/api/v1/deployments/${entry.id}`));
							entry.version = detail.version || "unknown";
							entry.healthy = detail.healthy;
							entry.region = entry.region || detail.region;
						} catch {
							entry.version = "unknown";
						}
					}
					out.push({ ...entry, version: entry.version || "unknown" });
				}
				return text(JSON.stringify({ count: out.length, deployments: out }, null, 2));
			} catch (err) {
				return text(
					`[elastic_cloud_list_deployment_versions error: ${err instanceof Error ? err.message : String(err)}]`,
				);
			}
		},
	);

	server.tool(
		"elastic_cloud_get_deployment",
		"Get an Elastic Cloud deployment (topology, sizing).",
		{ deploymentId: z.string() },
		async ({ deploymentId }) => text(await cloudFetch(`/api/v1/deployments/${deploymentId}`)),
	);

	server.tool(
		"elastic_cloud_get_plan_history",
		"Get the plan history for a deployment's Elasticsearch resource (source of truth for tier changes).",
		{ deploymentId: z.string(), refId: z.string().optional() },
		async ({ deploymentId, refId }) =>
			text(
				await cloudFetch(
					`/api/v1/deployments/${deploymentId}/elasticsearch/${refId ?? "main-elasticsearch"}/plan/activity`,
				),
			),
	);

	// Cluster-API (data-plane) reads resolve a per-deployment URL + auth from config
	// (ELASTIC_IAC_CLUSTER_*), keyed by the `deployment` name -- never a model-supplied base URL.
	// A model-controlled URL would bypass the deployment allowlist and make this an SSRF primitive,
	// so the tool surface only takes a deployment name. Read-only (GET); never mutates.
	server.tool(
		"elastic_get_cluster_health",
		"Read cluster health for a configured deployment's cluster API.",
		{ deployment: z.string().optional() },
		async ({ deployment }) => text(await clusterFetch(config.clusterDeployments, deployment, "/_cluster/health")),
	);

	server.tool(
		"elastic_get_index_template",
		"Read an index template (composable/component) from a configured deployment's cluster API.",
		{ name: z.string(), deployment: z.string().optional() },
		async ({ name, deployment }) =>
			text(await clusterFetch(config.clusterDeployments, deployment, `/_index_template/${name}`)),
	);

	server.tool(
		"elastic_ilm_get_lifecycle",
		"Read an ILM policy from a configured deployment's cluster API. Pass `deployment` (cluster name) to resolve the configured URL + auth.",
		{ policy: z.string(), deployment: z.string().optional() },
		async ({ policy, deployment }) =>
			text(await clusterFetch(config.clusterDeployments, deployment, `/_ilm/policy/${encodeURIComponent(policy)}`)),
	);

	// SIO-1020: simulate an INLINE ingest-pipeline body against a configured deployment's data-plane
	// _ingest/pipeline/_simulate API, so the elastic-iac agent can validate a pasted @custom pipeline
	// (processor compilation, grok-pattern compile, script compile) BEFORE opening the MR. Takes the
	// deployment NAME only (never a model-supplied URL -- same SSRF-safe contract as the read tools);
	// _simulate is read-only and never mutates the cluster. Default docs to a single empty document so
	// a pure structural simulate works without the caller providing sample data.
	server.tool(
		"elastic_simulate_ingest_pipeline",
		"Simulate an inline ingest-pipeline definition against a configured deployment's cluster API " +
			"(_ingest/pipeline/_simulate). Validates that the pipeline and its processors compile before it is " +
			"committed. Pass `pipeline` (the inline {processors:[...]} body), `deployment` (cluster name), and " +
			"optionally `docs` (sample documents; defaults to one empty doc) and `verbose`. Read-only.",
		{
			pipeline: z
				.record(z.string(), z.unknown())
				.describe('Inline pipeline definition, e.g. { processors: [ { drop: { if: "..." } } ] }.'),
			deployment: z.string().optional().describe("Configured deployment (cluster) name; resolves the URL + auth."),
			docs: z
				.array(z.record(z.string(), z.unknown()))
				.optional()
				.describe("Sample documents (each {_source:{...}} or bare fields). Defaults to a single empty document."),
			verbose: z.boolean().optional().describe("Show the result after each processor step, not just the final output."),
		},
		async ({ pipeline, deployment, docs, verbose }) => {
			const sampleDocs = (docs && docs.length > 0 ? docs : [{ _source: {} }]).map((doc) => ({
				_index: (doc._index as string | undefined) ?? "_simulate",
				_id: (doc._id as string | undefined) ?? "_id",
				_source: (doc._source ?? doc) as Record<string, unknown>,
			}));
			const body = JSON.stringify({ pipeline, docs: sampleDocs });
			const path = `/_ingest/pipeline/_simulate${verbose ? "?verbose=true" : ""}`;
			return text(await clusterPost(config.clusterDeployments, deployment, path, body));
		},
	);
}

// Resolve a configured cluster (by name) to its base URL + Authorization header. "" url => the
// deployment isn't configured (the caller surfaces a clear placeholder). (Pure; unit-tested.)
export function resolveCluster(
	deployments: ClusterDeployment[],
	deployment: string | undefined,
): { url: string; authHeader?: string } {
	const d = deployments.find((c) => c.id === deployment);
	if (!d) return { url: "" };
	if (d.apiKey) return { url: d.url, authHeader: `ApiKey ${d.apiKey}` };
	if (d.username && d.password) {
		return { url: d.url, authHeader: `Basic ${Buffer.from(`${d.username}:${d.password}`).toString("base64")}` };
	}
	return { url: d.url };
}

// Read-only GET against a configured per-deployment cluster. Returns a clear "not configured"
// placeholder when the deployment has no cluster connection (so reconcile-to-live blocks rather
// than guessing). Never mutates -- the agent observes; Terraform (via CI) applies.
async function clusterFetch(
	deployments: ClusterDeployment[],
	deployment: string | undefined,
	apiPath: string,
): Promise<string> {
	const { url, authHeader } = resolveCluster(deployments, deployment);
	if (!url) {
		return `[cluster '${deployment ?? "(unset)"}' not configured: set ELASTIC_IAC_CLUSTER_DEPLOYMENTS + ELASTIC_IAC_CLUSTER_<ID>_URL]`;
	}
	return clusterFetchRaw(url, apiPath, authHeader);
}

async function clusterFetchRaw(baseUrl: string, apiPath: string, authHeader?: string): Promise<string> {
	try {
		const res = await fetch(`${baseUrl}${apiPath}`, authHeader ? { headers: { Authorization: authHeader } } : {});
		return `[${res.status}] ${await res.text()}`;
	} catch (err) {
		return `[cluster request failed: ${err instanceof Error ? err.message : String(err)}]`;
	}
}

// SIO-1020: POST sibling of clusterFetch for the data-plane _simulate endpoint. Resolves the same
// per-deployment URL + auth (deployment NAME only -- never a model-supplied base URL), sends a JSON
// body, and returns the same `[<status>] <body>` convention. Used only for read-only simulate calls;
// the toolset never POSTs a mutation.
async function clusterPost(
	deployments: ClusterDeployment[],
	deployment: string | undefined,
	apiPath: string,
	body: string,
): Promise<string> {
	const { url, authHeader } = resolveCluster(deployments, deployment);
	if (!url) {
		return `[cluster '${deployment ?? "(unset)"}' not configured: set ELASTIC_IAC_CLUSTER_DEPLOYMENTS + ELASTIC_IAC_CLUSTER_<ID>_URL]`;
	}
	try {
		const res = await fetch(`${url}${apiPath}`, {
			method: "POST",
			headers: { "Content-Type": "application/json", ...(authHeader ? { Authorization: authHeader } : {}) },
			body,
		});
		return `[${res.status}] ${await res.text()}`;
	} catch (err) {
		return `[cluster request failed: ${err instanceof Error ? err.message : String(err)}]`;
	}
}

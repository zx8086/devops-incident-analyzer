// src/tools/elastic.ts
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Config } from "../config.ts";
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

	// Cluster-API reads go through a per-cluster URL the caller supplies (env-injected
	// in real deployments); here they return a clear placeholder when unset.
	server.tool(
		"elastic_get_cluster_health",
		"Read cluster health for the connected deployment.",
		{ clusterUrl: z.string().optional() },
		async ({ clusterUrl }) => text(await clusterFetch(clusterUrl, "/_cluster/health")),
	);

	server.tool(
		"elastic_get_index_template",
		"Read an index template (composable/component).",
		{ name: z.string(), clusterUrl: z.string().optional() },
		async ({ name, clusterUrl }) => text(await clusterFetch(clusterUrl, `/_index_template/${name}`)),
	);

	server.tool(
		"elastic_ilm_get_lifecycle",
		"Read an ILM policy.",
		{ policy: z.string(), clusterUrl: z.string().optional() },
		async ({ policy, clusterUrl }) => text(await clusterFetch(clusterUrl, `/_ilm/policy/${policy}`)),
	);
}

async function clusterFetch(clusterUrl: string | undefined, apiPath: string): Promise<string> {
	if (!clusterUrl) return "[cluster URL not provided: pass clusterUrl or configure per-deployment endpoints]";
	try {
		const res = await fetch(`${clusterUrl}${apiPath}`);
		return `[${res.status}] ${await res.text()}`;
	} catch (err) {
		return `[cluster request failed: ${err instanceof Error ? err.message : String(err)}]`;
	}
}

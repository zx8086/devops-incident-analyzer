// src/tools/elastic.ts
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Config } from "../config.ts";
import { text } from "./shared.ts";

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

	server.tool("elastic_cloud_list_deployments", "List Elastic Cloud deployments.", {}, async () =>
		text(await cloudFetch("/api/v1/deployments")),
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

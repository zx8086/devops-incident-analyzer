// apps/web/src/routes/api/datasources/+server.ts
import { getConnectedServers } from "@devops-agent/agent";
import { json } from "@sveltejs/kit";
import { ensureMcpConnected } from "$lib/server/agent";
import type { RequestHandler } from "./$types";

const SERVER_TO_DATASOURCE: Record<string, string> = {
	"elastic-mcp": "elastic",
	"kafka-mcp": "kafka",
	"couchbase-mcp": "couchbase",
	"konnect-mcp": "konnect",
	"gitlab-mcp": "gitlab",
	"atlassian-mcp": "atlassian",
	"aws-mcp": "aws",
};

export const GET: RequestHandler = async () => {
	// Ensure MCP servers are connected before checking status
	await ensureMcpConnected();

	// Report all configured datasources (from env vars)
	const dataSources: string[] = [];
	if (process.env.ELASTIC_MCP_URL) dataSources.push("elastic");
	if (process.env.KAFKA_MCP_URL) dataSources.push("kafka");
	if (process.env.COUCHBASE_MCP_URL) dataSources.push("couchbase");
	if (process.env.KONNECT_MCP_URL) dataSources.push("konnect");
	if (process.env.GITLAB_MCP_URL) dataSources.push("gitlab");
	if (process.env.ATLASSIAN_MCP_URL_LOCAL) dataSources.push("atlassian");
	if (process.env.AWS_MCP_URL) dataSources.push("aws");

	// Report which are actually connected
	const connected = getConnectedServers()
		.map((s) => SERVER_TO_DATASOURCE[s])
		.filter(Boolean);

	return json({ dataSources, connected });
};

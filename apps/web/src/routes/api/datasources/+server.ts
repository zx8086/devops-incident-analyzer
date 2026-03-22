// apps/web/src/routes/api/datasources/+server.ts
import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async () => {
	const dataSources: string[] = [];

	if (process.env.ELASTIC_MCP_URL) dataSources.push("elastic");
	if (process.env.KAFKA_MCP_URL) dataSources.push("kafka");
	if (process.env.COUCHBASE_MCP_URL) dataSources.push("couchbase");
	if (process.env.KONNECT_MCP_URL) dataSources.push("konnect");

	return json({ dataSources });
};

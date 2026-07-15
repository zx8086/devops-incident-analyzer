// src/tools/getClusterHealth.ts

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Bucket } from "couchbase";
import { z } from "zod";
import { resolveBucket } from "../lib/resolveBucket";
import { logger } from "../utils/logger";

// SIO-1107: structured per-service health with latency (ported from the official
// Couchbase MCP server's get_cluster_health_and_services). With bucket_name the
// ping runs against that bucket's services; without it, against the cluster.
// capella_ping remains the cheap text-only liveness check.
export const getClusterHealthHandler = async (params: { bucket_name?: string }, bucket: Bucket) => {
	try {
		const target = params.bucket_name ? resolveBucket(bucket, params.bucket_name) : bucket.cluster;
		const pingResult = await target.ping();
		// PingResult has toJSON() in the SDK; fall back to the raw object for mocks.
		const raw =
			typeof (pingResult as { toJSON?: () => unknown }).toJSON === "function"
				? (pingResult as { toJSON: () => unknown }).toJSON()
				: pingResult;
		const payload = {
			scope: params.bucket_name ? `bucket:${params.bucket_name}` : "cluster",
			ping: raw,
		};
		return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }] };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		logger.error({ error: message, bucket: params.bucket_name }, "Cluster health ping failed");
		return {
			content: [{ type: "text" as const, text: JSON.stringify({ error: message }) }],
			isError: true,
		};
	}
};

export default (server: McpServer, bucket: Bucket) => {
	server.tool(
		"capella_get_cluster_health",
		"Get cluster health and running services with per-service latency (ping). Optionally scoped to a bucket.",
		{
			bucket_name: z.string().optional().describe("Optional bucket to ping instead of the cluster"),
		},
		async (params) => {
			logger.info({ bucket: params.bucket_name }, "Getting cluster health");
			return getClusterHealthHandler(params, bucket);
		},
	);
};

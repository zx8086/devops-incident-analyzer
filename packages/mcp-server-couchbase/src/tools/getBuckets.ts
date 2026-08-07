// src/tools/getBuckets.ts

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Bucket } from "couchbase";
import { logger } from "../utils/logger";
import { couchbaseToolAnnotations } from "./tool-classification";

// SIO-1107: bucket enumeration (ported from the official Couchbase MCP server's
// get_buckets_in_cluster). Bare-JSON output so the agent's resolveIdentifiers
// probe can parse it structurally; `default_bucket` is load-bearing -- the probe
// uses it to scope index info to the env-configured bucket.
export const getBucketsHandler = async (bucket: Bucket) => {
	try {
		const all = await bucket.cluster.buckets().getAllBuckets();
		const payload = {
			default_bucket: bucket.name,
			buckets: all.map((b) => ({
				name: b.name,
				bucketType: b.bucketType,
				ramQuotaMB: b.ramQuotaMB,
				numReplicas: b.numReplicas,
			})),
		};
		return { content: [{ type: "text" as const, text: JSON.stringify(payload) }] };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		logger.error({ error: message }, "Failed to list buckets");
		return {
			content: [{ type: "text" as const, text: JSON.stringify({ error: message }) }],
			isError: true,
		};
	}
};

export default (server: McpServer, bucket: Bucket) => {
	server.registerTool(
		"capella_get_buckets",
		{
			description:
				"Get the names and settings of all accessible buckets in the cluster, plus which bucket is the configured default",
			inputSchema: {},
			annotations: couchbaseToolAnnotations("capella_get_buckets"),
		},
		async () => {
			logger.info("Listing buckets in cluster");
			return getBucketsHandler(bucket);
		},
	);
};

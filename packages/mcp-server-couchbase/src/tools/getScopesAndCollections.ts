/* src/tools/getScopesAndCollections.ts */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Bucket, ScopeSpec } from "couchbase";
import { z } from "zod";
import { resolveBucket } from "../lib/resolveBucket";
import { TtlCache } from "../lib/ttlCache";

// Topology changes rarely, but agents call this tool multiple times per turn
// (often back-to-back). A short TTL keeps duplicates off the cluster while
// staying fresh enough to see new collections within half a minute.
const scopesCache = new TtlCache<ScopeSpec[]>(30_000);

// SIO-1107: the `Scope:` / `Collection:` line prefixes are a parser contract
// with the agent's resolveIdentifiers probe (parseCouchbaseScopeTree) -- extra
// lines like the `Bucket:` header are ignored there, but the tree line format
// must not change.
const getScopesAndCollectionsHandler = async (params: { bucket_name?: string }, bucket: Bucket) => {
	const resolved = resolveBucket(bucket, params.bucket_name);
	const scopes = await scopesCache.getOrLoad(resolved.name, () => resolved.collections().getAllScopes());
	const scopesCollections: Record<string, string[]> = {};

	for (const scope of scopes) {
		scopesCollections[scope.name] = scope.collections.map((c) => c.name);
	}

	let formattedText = `Bucket: ${resolved.name}\n\n`;
	formattedText += "Here are all the scopes and collections in the bucket:\n\n";

	Object.entries(scopesCollections).forEach(([scope, collections]) => {
		formattedText += `📁 Scope: ${scope}\n`;
		if (collections && collections.length > 0) {
			collections.forEach((collection) => {
				formattedText += `  └─ 📄 Collection: ${collection}\n`;
			});
		} else {
			formattedText += "  └─ (No collections)\n";
		}
		formattedText += "\n";
	});

	return {
		content: [
			{
				type: "text" as const,
				text: formattedText,
			},
		],
	};
};

export default (server: McpServer, bucket: Bucket) => {
	server.tool(
		"capella_get_scopes_and_collections",
		"Get all scopes and collections in a bucket (defaults to the configured bucket)",
		{
			bucket_name: z.string().optional().describe("Optional bucket name (defaults to the configured bucket)"),
		},
		async (params: { bucket_name?: string }) => {
			if (!params || typeof params !== "object") {
				throw new Error("Missing required arguments object");
			}
			return getScopesAndCollectionsHandler(params, bucket);
		},
	);
};

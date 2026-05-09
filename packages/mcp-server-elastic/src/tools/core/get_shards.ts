/* src/tools/core/get_shards.ts */

import type { Client } from "@elastic/elasticsearch";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { getDiscoveryRequestOptions } from "../../utils/discoveryRequestOptions.js";
import { logger } from "../../utils/logger.js";
import {
	createPaginationHeader,
	PaginationLimitError,
	paginateResults,
	responsePresets,
} from "../../utils/responseHandling.js";
import type { SearchResult, ToolRegistrationFunction } from "../types.js";
import { humaniseBytes } from "./list_indices.js";

const _getShardsSchema = {
	type: "object",
	properties: {
		index: {
			type: "string",
			description: "Optional Elasticsearch index name to get shard information for",
		},
		limit: {
			type: "integer",
			minimum: 1,
			maximum: 1000,
			description: "Maximum number of shards to return (default: 100, max: 1000). Unhealthy shards are prioritized.",
		},
		sortBy: {
			type: "string",
			enum: ["state", "index", "size", "docs"],
			description: "Sort order for shards. 'state' sorts unhealthy first (default: 'state')",
		},
	},
	additionalProperties: false,
};

const getShardsValidator = z.object({
	index: z.string().optional(),
	limit: z.number().min(1).max(1000).optional(),
	sortBy: z.enum(["state", "index", "size", "docs"]).optional(),
});

type GetShardsParams = z.infer<typeof getShardsValidator>;

function createGetShardsMcpError(
	error: Error | string,
	context: { type: string; details?: Record<string, unknown> },
): McpError {
	const message = error instanceof Error ? error.message : error;

	if (message.includes("index_not_found")) {
		return new McpError(ErrorCode.InvalidRequest, `Index not found: ${context.details?.index || "unknown"}`);
	}

	if (message.includes("cluster_block_exception")) {
		return new McpError(ErrorCode.InvalidRequest, "Cluster is blocked for shard operations");
	}

	if (message.includes("timeout")) {
		return new McpError(ErrorCode.RequestTimeout, "Request timed out while retrieving shard information");
	}

	return new McpError(ErrorCode.InternalError, `Failed to get shard information: ${message}`);
}

export const registerGetShardsTool: ToolRegistrationFunction = (server: McpServer, esClient: Client) => {
	const getShardsHandler = async (args: GetShardsParams): Promise<SearchResult> => {
		const perfStart = performance.now();

		try {
			const params = getShardsValidator.parse(args);
			const { index, limit, sortBy } = params;

			logger.debug({ index, limit, sortBy }, "Getting shard information");

			// SIO-660: `store` on _cat/shards is formatted ("12.3gb") by default; the
			// comparator previously stripped non-digits and sorted lexicographically
			// (997kb > 12gb). With `bytes: "b"` the column becomes a raw integer, so
			// the comparator can parse it directly. Humanised back in the response.
			const response = await esClient.cat.shards(
				{
					...(index && { index }),
					format: "json",
					h: "index,shard,prirep,state,docs,store,ip,node",
					...(sortBy === "size" && { bytes: "b" as const }),
				},
				getDiscoveryRequestOptions(),
			);

			const totalShards = response.length;
			const duration = performance.now() - perfStart;
			logger.debug(
				{
					totalCount: totalShards,
					requestedLimit: limit,
					duration: `${duration.toFixed(2)}ms`,
				},
				"Retrieved shard information",
			);

			// SIO-660: when sorting by size, rows without `store` (typically UNASSIGNED
			// replicas or closed/frozen shards) can't be compared. Partition before sort
			// and surface the excluded count in metadata so the result is honest rather
			// than silently short.
			let excludedForMissingStore = 0;
			let sortedShards: typeof response;
			if (sortBy === "size") {
				const withStore = response.filter((row) => row.store);
				excludedForMissingStore = response.length - withStore.length;
				sortedShards = [...withStore];
			} else {
				sortedShards = [...response];
			}

			if (sortBy === "state") {
				sortedShards.sort((a, b) => {
					const stateOrder: Record<string, number> = {
						UNASSIGNED: 0,
						INITIALIZING: 1,
						RELOCATING: 2,
						STARTED: 3,
					};
					const aOrder = stateOrder[a.state as string] ?? 4;
					const bOrder = stateOrder[b.state as string] ?? 4;
					if (aOrder !== bOrder) return aOrder - bOrder;
					return (a.index as string).localeCompare(b.index as string);
				});
			} else if (sortBy === "size") {
				// Rows without `store` were already partitioned out above. Remaining rows
				// are guaranteed to have raw byte integers (bytes=b on cat.shards).
				sortedShards.sort((a, b) => {
					const sizeA = Number.parseInt((a.store as string) || "0", 10);
					const sizeB = Number.parseInt((b.store as string) || "0", 10);
					return sizeB - sizeA;
				});
			} else if (sortBy === "docs") {
				sortedShards.sort((a, b) => {
					const docsA = Number.parseInt((a.docs as string) || "0", 10);
					const docsB = Number.parseInt((b.docs as string) || "0", 10);
					return docsB - docsA;
				});
			} else if (sortBy === "index") {
				sortedShards.sort((a, b) => (a.index as string).localeCompare(b.index as string));
			}

			// SIO-655: maxLimit now matches the schema cap (1000), and paginateResults
			// throws on over-cap requests rather than silently clamping.
			let paginatedShards: typeof sortedShards;
			let metadata: import("../../utils/responseHandling.js").ResponseMetadata;
			try {
				const paginated = paginateResults(sortedShards, {
					limit,
					defaultLimit: responsePresets.list.defaultLimit,
					maxLimit: 1000,
				});
				paginatedShards = paginated.results;
				metadata = paginated.metadata;
			} catch (error) {
				if (error instanceof PaginationLimitError) {
					throw new McpError(
						ErrorCode.InvalidParams,
						`limit=${error.requested} exceeds the maximum of ${error.maxLimit} for this tool.`,
						{ requested: error.requested, maxLimit: error.maxLimit },
					);
				}
				throw error;
			}

			const unhealthyCount = response.filter((s) => s.state !== "STARTED").length;

			const shardsInfo = paginatedShards.map((shard) => ({
				index: shard.index,
				shard: shard.shard,
				prirep: shard.prirep,
				state: shard.state,
				docs: shard.docs,
				// SIO-660: `store` is raw bytes only when we requested bytes=b (sortBy=size).
				// Humanise in that case; otherwise pass through the ES-formatted string.
				store: sortBy === "size" ? humaniseBytes(shard.store as string | undefined) : shard.store,
				ip: shard.ip,
				node: shard.node,
			}));

			// Create pagination header and metadata
			const headerText = createPaginationHeader(metadata, `Shards${index ? ` for index ${index}` : ""}`);

			let metadataText = `Total: ${totalShards} shards`;
			if (index) metadataText += ` for index ${index}`;
			if (sortBy) metadataText += ` (sorted by ${sortBy})`;

			if (unhealthyCount > 0) {
				metadataText += `\n${unhealthyCount} unhealthy shards found`;
			}
			// SIO-660: disclose rows dropped from the sort because they lacked `store`.
			if (excludedForMissingStore > 0) {
				metadataText += `\n${excludedForMissingStore} shards excluded from size sort (unassigned or closed — no storage data)`;
			}

			return {
				content: [
					{ type: "text", text: headerText },
					{ type: "text", text: metadataText },
					{ type: "text", text: JSON.stringify(shardsInfo, null, 2) },
				],
			};
		} catch (error) {
			const duration = performance.now() - perfStart;
			logger.error(
				{
					error: error instanceof Error ? error.message : String(error),
					duration: `${duration.toFixed(2)}ms`,
				},
				"Failed to get shard information",
			);
			throw createGetShardsMcpError(error instanceof Error ? error : new Error(String(error)), {
				type: "get_shards",
				details: args as Record<string, unknown>,
			});
		}
	};

	// Tool registration using modern registerTool method

	server.registerTool(
		"elasticsearch_get_shards",

		{
			title: "Get Shards",

			description:
				"Get shard information. WARNING: Clusters often have 1000+ shards. Check cluster stats first to see shard count. If >500 shards, MUST use 'limit' or will fail. Patterns: {limit: 100, sortBy: 'state'} for health check, {limit: 50, sortBy: 'size'} for storage analysis. Empty {} only works for small clusters (<500 shards). FIXED: Uses Zod Schema for proper MCP parameter handling.",

			inputSchema: getShardsValidator.shape,
		},

		getShardsHandler,
	);
};

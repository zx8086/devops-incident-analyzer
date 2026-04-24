/* src/tools/core/list_indices.ts */

import type { Client } from "@elastic/elasticsearch";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { logger } from "../../utils/logger.js";
import { OperationType, withReadOnlyCheck } from "../../utils/readOnlyMode.js";
import {
	createPaginationHeader,
	PaginationLimitError,
	paginateResults,
	responsePresets,
} from "../../utils/responseHandling.js";
import type { SearchResult, ToolRegistrationFunction } from "../types.js";

// Direct JSON Schema definition
const _listIndicesSchema = {
	type: "object",
	properties: {
		indexPattern: {
			type: "string",
			description: "Index pattern to match. Use '*' for all indices. Supports wildcards like 'logs-*' or 'app-*'",
		},
		limit: {
			type: "number",
			minimum: 1,
			maximum: 1000,
			description: "Maximum number of indices to return (1-1000). Required for large clusters",
		},
		excludeSystemIndices: {
			type: "boolean",
			description: "Exclude system indices starting with '.'",
		},
		excludeDataStreams: {
			type: "boolean",
			description: "Exclude data stream backing indices",
		},
		sortBy: {
			type: "string",
			enum: ["name", "size", "docs", "creation"],
			description:
				"Sort key: 'name' (lexicographic), 'size' (store.size_in_bytes — not available for closed indices), 'docs' (docs.count), or 'creation' (creation date).",
		},
		sortOrder: {
			type: "string",
			enum: ["asc", "desc"],
			description: "Sort direction. Default per key: size/docs/creation -> desc, name -> asc.",
		},
		includeSize: {
			type: "boolean",
			description: "Include storage size and creation date information",
		},
	},
	additionalProperties: false,
};

// Zod validator for runtime validation
const listIndicesValidator = z.object({
	indexPattern: z.string().optional(),
	limit: z.number().min(1).max(1000).optional(),
	excludeSystemIndices: z.boolean().optional(),
	excludeDataStreams: z.boolean().optional(),
	sortBy: z.enum(["name", "size", "docs", "creation"]).optional(),
	sortOrder: z.enum(["asc", "desc"]).optional(),
	includeSize: z.boolean().optional(),
});

type _ListIndicesParams = z.infer<typeof listIndicesValidator>;

// MCP error handling

function createMcpError(
	error: Error | string,
	context: {
		toolName: string;
		type: "validation" | "execution" | "connection" | "not_found";
		details?: any;
	},
): McpError {
	const message = error instanceof Error ? error.message : error;

	const errorCodeMap = {
		validation: ErrorCode.InvalidParams,
		execution: ErrorCode.InternalError,
		connection: ErrorCode.InternalError,
		not_found: ErrorCode.InvalidRequest,
	};

	return new McpError(errorCodeMap[context.type], `[${context.toolName}] ${message}`, context.details);
}

// Tool implementation

export const registerListIndicesTool: ToolRegistrationFunction = (server: McpServer, esClient: Client) => {
	// Tool handler
	const listIndicesHandler = async (args: any): Promise<SearchResult> => {
		const perfStart = performance.now();

		try {
			// Validate parameters
			const params = listIndicesValidator.parse(args);

			logger.debug(
				{
					pattern: params.indexPattern,
					limit: params.limit,
					filters: {
						excludeSystemIndices: params.excludeSystemIndices,
						excludeDataStreams: params.excludeDataStreams,
					},
				},
				"Listing indices",
			);

			// Build the cat indices request. Request store.size_in_bytes whenever we
			// sort or display size so the sort key is numeric (SIO-652); creation date
			// is requested when sorting by creation or when includeSize is set.
			const needsBytes = params.sortBy === "size" || params.includeSize === true;
			const showSizeColumn = params.includeSize === true || params.sortBy === "size";
			const needsCreation = params.sortBy === "creation" || params.includeSize === true;
			const headerParts = ["index", "health", "status", "docs.count"];
			if (showSizeColumn) {
				headerParts.push("store.size");
			}
			if (needsCreation) {
				headerParts.push("creation.date.string");
			}
			if (needsBytes) {
				headerParts.push("store.size_in_bytes");
			}
			const catParams = {
				index: params.indexPattern,
				format: "json" as const,
				h: headerParts.join(","),
			};

			const response = await esClient.cat.indices(catParams);

			// Apply filtering
			const filteredIndices = response.filter((index: any) => {
				if (params.excludeSystemIndices && index.index.startsWith(".")) {
					return false;
				}
				if (params.excludeDataStreams && index.index.includes(".ds-")) {
					return false;
				}
				return true;
			});

			// SIO-655: before sorting, validate every row has the required key. Silent
			// 0-fallbacks on undefined fields cause stable original-order output while
			// metadata still claims the sort ran — the exact failure from the Apr 23
			// addendum. Closed/frozen indices legitimately lack store.size_in_bytes;
			// fail loud so the caller picks a different sortBy.
			const sortKeyFieldBySortBy: Record<"size" | "docs" | "creation", string> = {
				size: "store.size_in_bytes",
				docs: "docs.count",
				creation: "creation.date.string",
			};
			if (params.sortBy && params.sortBy !== "name") {
				const requiredField = sortKeyFieldBySortBy[params.sortBy];
				const missing = filteredIndices
					.filter((row: any) => !row[requiredField])
					.map((row: any) => row.index as string);
				if (missing.length > 0) {
					throw createMcpError(
						`Cannot sort by '${params.sortBy}': ${missing.length}/${filteredIndices.length} indices missing '${requiredField}'. This usually means the result set includes closed or frozen-tier indices that do not expose this field. Retry with a different sortBy (e.g. 'name'), narrow the indexPattern, or exclude system indices.`,
						{
							toolName: "elasticsearch_list_indices",
							type: "validation",
							details: {
								sortBy: params.sortBy,
								requiredField,
								missingCount: missing.length,
								totalCount: filteredIndices.length,
								sampleMissing: missing.slice(0, 10),
							},
						},
					);
				}
			}

			// Resolve effective sort order with per-key defaults.
			const defaultOrderBySortBy: Record<"name" | "size" | "docs" | "creation", "asc" | "desc"> = {
				size: "desc",
				docs: "desc",
				creation: "desc",
				name: "asc",
			};
			const resolvedOrder: "asc" | "desc" =
				params.sortOrder ?? (params.sortBy ? defaultOrderBySortBy[params.sortBy] : "asc");
			const directionMultiplier = resolvedOrder === "asc" ? 1 : -1;

			filteredIndices.sort((a: any, b: any) => {
				switch (params.sortBy) {
					case "size": {
						const sizeA = Number.parseInt(a["store.size_in_bytes"], 10);
						const sizeB = Number.parseInt(b["store.size_in_bytes"], 10);
						return (sizeA - sizeB) * directionMultiplier;
					}
					case "docs": {
						const docsA = Number.parseInt(a["docs.count"], 10);
						const docsB = Number.parseInt(b["docs.count"], 10);
						return (docsA - docsB) * directionMultiplier;
					}
					case "creation": {
						const dateA = a["creation.date.string"] || "";
						const dateB = b["creation.date.string"] || "";
						return dateA.localeCompare(dateB) * directionMultiplier;
					}
					default:
						return a.index.localeCompare(b.index) * directionMultiplier;
				}
			});

			// Pagination. maxLimit matches the Zod schema cap (1000) rather than the
			// shared list preset (100); callers that need more rows for enumeration
			// rely on this (SIO-655). Over-cap requests now throw loud, not silent.
			let paginatedIndices: any[];
			let metadata: import("../../utils/responseHandling.js").ResponseMetadata;
			try {
				const paginated = paginateResults(filteredIndices, {
					limit: params.limit,
					defaultLimit: responsePresets.list.defaultLimit,
					maxLimit: 1000,
				});
				paginatedIndices = paginated.results;
				metadata = paginated.metadata;
			} catch (error) {
				if (error instanceof PaginationLimitError) {
					throw createMcpError(`limit=${error.requested} exceeds the maximum of ${error.maxLimit} for this tool.`, {
						toolName: "elasticsearch_list_indices",
						type: "validation",
						details: { requested: error.requested, maxLimit: error.maxLimit },
					});
				}
				throw error;
			}

			// Transform to consistent format. Auto-include storeSize when the caller
			// sorted by it so they see the field they sorted on (SIO-655).
			const includeSizeInOutput = params.includeSize === true || params.sortBy === "size";
			const indicesInfo = paginatedIndices.map((index: any) => ({
				index: index.index,
				health: index.health,
				status: index.status,
				docsCount: index["docs.count"] || "0",
				...(includeSizeInOutput && {
					storeSize: index["store.size"] || "0b",
					creationDate: index["creation.date.string"] || "unknown",
				}),
			}));

			const summary = {
				total_found: filteredIndices.length,
				displayed: indicesInfo.length,
				limit_applied: metadata.effectiveLimit,
				filters_applied: {
					excluded_system_indices: params.excludeSystemIndices,
					excluded_data_streams: params.excludeDataStreams,
				},
				sorted_by: params.sortBy ? { key: params.sortBy, order: resolvedOrder } : null,
			};

			const duration = performance.now() - perfStart;
			if (duration > 5000) {
				logger.warn({ duration }, "Slow operation: elasticsearch_list_indices");
			}

			const headerMessage = createPaginationHeader(metadata, "Indices");

			return {
				content: [
					{ type: "text", text: headerMessage },
					{ type: "text", text: JSON.stringify(summary, null, 2) },
					{ type: "text", text: JSON.stringify(indicesInfo, null, 2) },
				],
			};
		} catch (error) {
			// Error handling
			if (error instanceof z.ZodError) {
				throw createMcpError(`Validation failed: ${error.issues.map((e) => e.message).join(", ")}`, {
					toolName: "elasticsearch_list_indices",
					type: "validation",
					details: { validationErrors: error.issues, providedArgs: args },
				});
			}

			if (error instanceof Error && error.message.includes("index_not_found_exception")) {
				throw createMcpError(`No indices found matching pattern: ${args.indexPattern || "*"}`, {
					toolName: "elasticsearch_list_indices",
					type: "not_found",
					details: { pattern: args.indexPattern },
				});
			}

			throw createMcpError(error instanceof Error ? error.message : String(error), {
				toolName: "elasticsearch_list_indices",
				type: "execution",
				details: {
					duration: performance.now() - perfStart,
					args,
				},
			});
		}
	};

	// Tool registration using modern registerTool method
	server.registerTool(
		"elasticsearch_list_indices",
		{
			title: "List Elasticsearch Indices",
			description:
				"List indices with filtering, sorting, and honest pagination metadata. sortBy='size' ranks by primary+replica store bytes (store.size_in_bytes) and is unavailable for closed/frozen indices — request will fail loud if any row lacks the field. limit honoured up to 1000. TIP: Use this FIRST to check cluster size. Common patterns: {limit: 50, excludeSystemIndices: true} for overview, {indexPattern: 'logs-*', sortBy: 'size'} for ranking by storage.",
			inputSchema: {
				indexPattern: z.string().optional(),
				limit: z.number().min(1).max(1000).optional(),
				excludeSystemIndices: z.boolean().optional(),
				excludeDataStreams: z.boolean().optional(),
				sortBy: z.enum(["name", "size", "docs", "creation"]).optional(),
				sortOrder: z.enum(["asc", "desc"]).optional(),
				includeSize: z.boolean().optional(),
			},
		},
		withReadOnlyCheck("elasticsearch_list_indices", listIndicesHandler, OperationType.READ),
	);
};

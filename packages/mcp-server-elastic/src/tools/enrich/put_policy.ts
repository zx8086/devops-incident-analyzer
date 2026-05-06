/* src/tools/enrich/put_policy.ts */
/* FIXED: Uses Zod Schema instead of JSON Schema for MCP compatibility */

import type { Client } from "@elastic/elasticsearch";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { logger } from "../../utils/logger.js";
import type { SearchResult, TextContent, ToolRegistrationFunction } from "../types.js";

// Direct JSON Schema definition
// FIXED: Original JSON Schema definition removed - now using Zod schema inline

// Zod validator for runtime validation
const enrichSourceValidator = z.object({
	enrichFields: z.array(z.string()),
	indices: z.union([z.string(), z.array(z.string())]),
	matchField: z.string(),
	query: z.object({}).passthrough().optional(),
	name: z.string().optional(),
	elasticsearchVersion: z.string().optional(),
});

const putPolicyValidator = z.object({
	name: z.string().min(1, "Policy name cannot be empty").describe("Name of the enrich policy to create"),
	geoMatch: enrichSourceValidator.optional().describe("Configuration for geo_match enrich policy type"),
	match: enrichSourceValidator.optional().describe("Configuration for match enrich policy type"),
	range: enrichSourceValidator.optional().describe("Configuration for range enrich policy type"),
	masterTimeout: z.string().optional().describe("Timeout for master node operations. Examples: '30s', '1m'"),
});

type PutPolicyParams = z.infer<typeof putPolicyValidator>;

// MCP error handling
function createPutPolicyMcpError(
	error: Error | string,
	context: {
		type: "validation" | "execution" | "policy_already_exists" | "index_not_found" | "timeout";
		details?: unknown;
	},
): McpError {
	const message = error instanceof Error ? error.message : error;

	const errorCodeMap = {
		validation: ErrorCode.InvalidParams,
		execution: ErrorCode.InternalError,
		policy_already_exists: ErrorCode.InvalidParams,
		index_not_found: ErrorCode.InvalidParams,
		timeout: ErrorCode.InternalError,
	};

	return new McpError(errorCodeMap[context.type], `[elasticsearch_enrich_put_policy] ${message}`, context.details);
}

// Tool implementation
export const registerEnrichPutPolicyTool: ToolRegistrationFunction = (server: McpServer, esClient: Client) => {
	const putPolicyHandler = async (args: PutPolicyParams): Promise<SearchResult> => {
		const perfStart = performance.now();

		try {
			// Validate parameters
			const params = putPolicyValidator.parse(args);
			const { name, geoMatch, match, range, masterTimeout } = params;

			logger.debug({ name, geoMatch, match, range, masterTimeout }, "Creating enrich policy");

			// Validate that at least one policy type is provided
			if (!geoMatch && !match && !range) {
				throw createPutPolicyMcpError("At least one policy type (geoMatch, match, or range) must be provided", {
					type: "validation",
					details: { providedArgs: args },
				});
			}

			const result = await esClient.enrich.putPolicy({
				name,
				geo_match: geoMatch
					? {
							enrich_fields: geoMatch.enrichFields,
							indices: geoMatch.indices,
							match_field: geoMatch.matchField,
							query: geoMatch.query,
							name: geoMatch.name,
							elasticsearch_version: geoMatch.elasticsearchVersion,
						}
					: undefined,
				match: match
					? {
							enrich_fields: match.enrichFields,
							indices: match.indices,
							match_field: match.matchField,
							query: match.query,
							name: match.name,
							elasticsearch_version: match.elasticsearchVersion,
						}
					: undefined,
				range: range
					? {
							enrich_fields: range.enrichFields,
							indices: range.indices,
							match_field: range.matchField,
							query: range.query,
							name: range.name,
							elasticsearch_version: range.elasticsearchVersion,
						}
					: undefined,
				master_timeout: masterTimeout,
			});

			const duration = performance.now() - perfStart;
			if (duration > 10000) {
				logger.warn({ duration }, "Slow put enrich policy operation");
			}

			return {
				content: [{ type: "text", text: JSON.stringify(result, null, 2) } as TextContent],
			};
		} catch (error) {
			// Error handling
			if (error instanceof z.ZodError) {
				throw createPutPolicyMcpError(`Validation failed: ${error.issues.map((e) => e.message).join(", ")}`, {
					type: "validation",
					details: { validationErrors: error.issues, providedArgs: args },
				});
			}

			if (error instanceof Error) {
				if (error.message.includes("timeout") || error.message.includes("timed_out")) {
					throw createPutPolicyMcpError(`Operation timed out: ${error.message}`, {
						type: "timeout",
						details: { duration: performance.now() - perfStart },
					});
				}

				if (error.message.includes("already_exists") || error.message.includes("version_conflict")) {
					throw createPutPolicyMcpError(`Enrich policy already exists: ${args?.name || "unknown"}`, {
						type: "policy_already_exists",
						details: { policyName: args?.name },
					});
				}

				if (error.message.includes("index_not_found_exception")) {
					throw createPutPolicyMcpError(`Source index not found for enrich policy: ${error.message}`, {
						type: "index_not_found",
						details: { originalError: error.message },
					});
				}
			}

			throw createPutPolicyMcpError(error instanceof Error ? error.message : String(error), {
				type: "execution",
				details: {
					duration: performance.now() - perfStart,
					args,
				},
			});
		}
	};

	// SIO-671: read-only enforcement is now handled by the shared chokepoint.
	const putPolicyImpl = async (params: PutPolicyParams, _extra: Record<string, unknown>): Promise<SearchResult> => {
		return putPolicyHandler(params);
	};

	// Tool registration using modern registerTool method

	server.registerTool(
		"elasticsearch_enrich_put_policy",

		{
			title: "Enrich Put Policy",

			description:
				"Create an enrich policy in Elasticsearch. Best for data enrichment setup, reference data integration, document enhancement workflows. Use when you need to define policies for adding reference data to documents during ingestion in Elasticsearch.",

			inputSchema: putPolicyValidator.shape,
		},

		putPolicyImpl,
	);
};

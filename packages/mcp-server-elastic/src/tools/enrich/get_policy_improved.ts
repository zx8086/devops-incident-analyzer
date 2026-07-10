/* src/tools/enrich/get_policy_improved.ts */
/* FIXED: Uses Zod Schema instead of JSON Schema for MCP compatibility */
/* SIO-1047: getPolicyHandler split into module-private helpers (parse/fetch/shape/response) to cut cognitive complexity */

import type { Client, estypes } from "@elastic/elasticsearch";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { getDiscoveryRequestOptions } from "../../utils/discoveryRequestOptions.js";
import { logger } from "../../utils/logger.js";
import {
	createPaginationHeader,
	paginateResults,
	responsePresets,
	truncateResponse,
} from "../../utils/responseHandling.js";
import { throwZodValidationMcpError } from "../../utils/toolErrorHandling.js";
import type { SearchResult, TextContent, ToolRegistrationFunction } from "../types.js";

// Direct JSON Schema definition
// FIXED: Original JSON Schema definition removed - now using Zod schema inline

const getPolicyValidator = z.object({
	name: z
		.union([z.string(), z.array(z.string())])
		.optional()
		.describe("Policy name(s) to retrieve. Can be a single policy name or array of names"),
	masterTimeout: z.string().optional().describe("Timeout for master node operations. Examples: '30s', '1m'"),
	limit: z
		.union([
			z.number(),
			z
				.string()
				.regex(/^\d+$/)
				.transform((val) => Number.parseInt(val, 10)),
		])
		.pipe(z.number().min(1).max(50))
		.optional()
		.describe("Maximum number of policies to return. Range: 1-50"),
	summary: z.boolean().optional().describe("Return summarized policy information instead of full details"),
	sortBy: z.enum(["name", "type", "indices_count"]).optional().describe("Sort policies by specified field"),
});

type GetPolicyParams = z.infer<typeof getPolicyValidator>;

interface PolicySummary {
	name: string;
	type: string;
	source_indices: string[];
	match_field: string;
	enrich_fields: string[];
	query?: boolean;
	created?: string;
}

// EnrichSummary in some ES versions includes a top-level `created` timestamp
// not yet reflected in the SDK type. Augment locally for the read sites.
type EnrichSummaryWithCreated = estypes.EnrichSummary & { created?: string };

// Resolves the type-specific config block (match/geo_match/range) for a raw enrich policy entry.
function resolvePolicyConfig(config: EnrichSummaryWithCreated["config"]): {
	type: string;
	policyConfig: Partial<estypes.EnrichPolicy> & { name?: string };
} {
	if (config.match) {
		return { type: "match", policyConfig: config.match };
	}
	if (config.geo_match) {
		return { type: "geo_match", policyConfig: config.geo_match };
	}
	if (config.range) {
		return { type: "range", policyConfig: config.range };
	}
	return { type: "unknown", policyConfig: {} };
}

// Transforms raw ES enrich policy entries into the flattened summary shape used throughout the response.
function transformPolicySummaries(policies: EnrichSummaryWithCreated[]): PolicySummary[] {
	return policies.map((policy) => {
		const { type, policyConfig } = resolvePolicyConfig(policy.config);

		const rawIndices = policyConfig.indices;
		const sourceIndices: string[] = Array.isArray(rawIndices)
			? rawIndices.filter((s): s is string => typeof s === "string")
			: typeof rawIndices === "string"
				? [rawIndices]
				: [];
		const enrichFieldsRaw = policyConfig.enrich_fields;
		const enrichFields: string[] = Array.isArray(enrichFieldsRaw)
			? enrichFieldsRaw.filter((f): f is string => typeof f === "string")
			: typeof enrichFieldsRaw === "string"
				? [enrichFieldsRaw]
				: [];
		return {
			name: policyConfig.name || "unnamed",
			type: type,
			source_indices: sourceIndices,
			match_field: typeof policyConfig.match_field === "string" ? policyConfig.match_field : "",
			enrich_fields: enrichFields,
			query: !!policyConfig.query,
			created: policy.created || undefined,
		};
	});
}

// Finds the raw ES policy entry whose type-specific config name matches the given policy name.
function findRawPolicyByName(
	policies: EnrichSummaryWithCreated[],
	name: string | undefined,
): EnrichSummaryWithCreated | undefined {
	return policies.find((p) => {
		const cfg = p.config.match || p.config.geo_match || p.config.range;
		return cfg?.name === name;
	});
}

// Sort comparator for the sortBy param: name (default), type, or indices_count.
function comparePolicySummaries(a: PolicySummary, b: PolicySummary, sortBy: GetPolicyParams["sortBy"]): number {
	switch (sortBy) {
		case "type":
			return a.type.localeCompare(b.type);
		case "indices_count":
			return b.source_indices.length - a.source_indices.length;
		default:
			return a.name.localeCompare(b.name);
	}
}

// Summary-mode body for a single policy: type, match field, indices/fields (capped preview), query flag, created date.
function renderPolicySummaryEntry(policy: PolicySummary): string[] {
	const lines: string[] = [];
	lines.push(`### ${policy.name}`);
	lines.push(`- **Type**: ${policy.type}`);
	lines.push(`- **Match Field**: ${policy.match_field}`);

	lines.push(`- **Source Indices**: ${policy.source_indices.length}`);
	if (policy.source_indices.length <= 3) {
		for (const idx of policy.source_indices) {
			lines.push(`  - ${idx}`);
		}
	} else {
		for (const idx of policy.source_indices.slice(0, 2)) {
			lines.push(`  - ${idx}`);
		}
		lines.push(`  - ... and ${policy.source_indices.length - 2} more`);
	}

	lines.push(`- **Enrich Fields**: ${policy.enrich_fields.length}`);
	if (policy.enrich_fields.length <= 5) {
		for (const field of policy.enrich_fields) {
			lines.push(`  - ${field}`);
		}
	} else {
		for (const field of policy.enrich_fields.slice(0, 3)) {
			lines.push(`  - ${field}`);
		}
		lines.push(`  - ... and ${policy.enrich_fields.length - 3} more`);
	}

	if (policy.query) {
		lines.push("- **Has Query Filter**: Yes");
	}

	if (policy.created) {
		lines.push(`- **Created**: ${new Date(policy.created).toISOString().split("T")[0]}`);
	}

	lines.push("");
	return lines;
}

// Aggregate stats block (type distribution, average enrich fields, query-filter count) shown when total > 5.
function renderPolicyStatistics(policySummaries: PolicySummary[], total: number): string[] {
	const lines: string[] = [];
	lines.push("\n## Policy Statistics");

	const typeCount = policySummaries.reduce(
		(acc, p) => {
			acc[p.type] = (acc[p.type] || 0) + 1;
			return acc;
		},
		{} as Record<string, number>,
	);

	lines.push(`- **Total Policies**: ${total}`);
	lines.push("- **Policy Types**:");
	for (const [type, count] of Object.entries(typeCount).sort(([, a], [, b]) => b - a)) {
		lines.push(`  - ${type}: ${count}`);
	}

	const avgFields = (
		policySummaries.reduce((sum, p) => sum + p.enrich_fields.length, 0) / policySummaries.length
	).toFixed(1);
	lines.push(`- **Average Enrich Fields**: ${avgFields}`);

	const withQuery = policySummaries.filter((p) => p.query).length;
	if (withQuery > 0) {
		lines.push(`- **Policies with Query Filter**: ${withQuery}`);
	}

	return lines;
}

// Full summary-mode response body: per-policy entries plus the aggregate statistics block when total > 5.
function buildSummaryModeContent(
	paginatedPolicies: PolicySummary[],
	policySummaries: PolicySummary[],
	total: number,
): string[] {
	const lines: string[] = [];
	for (const policy of paginatedPolicies) {
		lines.push(...renderPolicySummaryEntry(policy));
	}

	if (total > 5) {
		lines.push(...renderPolicyStatistics(policySummaries, total));
	}

	return lines;
}

// Detailed-mode response body: full raw JSON for each paginated policy.
function buildDetailedModeContent(paginatedPolicies: PolicySummary[], policies: EnrichSummaryWithCreated[]): string[] {
	const lines: string[] = [];
	lines.push("## Policy Details\n");
	lines.push("```json");

	const detailedResults = paginatedPolicies.map((policySummary) => findRawPolicyByName(policies, policySummary.name));

	lines.push(JSON.stringify(detailedResults, null, 2));
	lines.push("```");
	return lines;
}

// MCP error handling
function createGetPolicyMcpError(
	error: Error | string,
	context: {
		type: "validation" | "execution" | "policy_not_found" | "timeout" | "parsing";
		details?: unknown;
	},
): McpError {
	const message = error instanceof Error ? error.message : error;

	const errorCodeMap = {
		validation: ErrorCode.InvalidParams,
		execution: ErrorCode.InternalError,
		policy_not_found: ErrorCode.InvalidParams,
		timeout: ErrorCode.InternalError,
		parsing: ErrorCode.InternalError,
	};

	return new McpError(errorCodeMap[context.type], `[elasticsearch_enrich_get_policy] ${message}`, context.details);
}

// Tool implementation
export const registerEnrichGetPolicyTool: ToolRegistrationFunction = (server: McpServer, esClient: Client) => {
	const getPolicyHandler = async (args: GetPolicyParams): Promise<SearchResult> => {
		const perfStart = performance.now();

		try {
			// Validate parameters
			const params = getPolicyValidator.parse(args);
			const { name, masterTimeout, limit, summary, sortBy } = params;

			logger.debug({ name, masterTimeout, limit, summary, sortBy }, "Getting enrich policies");

			// Fetch policies from Elasticsearch
			const result = await esClient.enrich.getPolicy(
				{
					name,
					master_timeout: masterTimeout,
				},
				getDiscoveryRequestOptions(),
			);

			// Extract policies array
			const policies: EnrichSummaryWithCreated[] = (result.policies || []) as EnrichSummaryWithCreated[];

			// Transform policies into summary format
			const policySummaries: PolicySummary[] = transformPolicySummaries(policies);

			// If a specific policy was requested, filter results
			if (name && !Array.isArray(name)) {
				const filtered = policySummaries.filter((p) => p.name === name);
				if (filtered.length === 1) {
					// Return just the specific policy requested
					const policy = findRawPolicyByName(policies, name);
					return {
						content: [
							{
								type: "text",
								text: `## Enrich Policy: ${name}\n\n\`\`\`json\n${JSON.stringify(policy, null, 2)}\n\`\`\``,
							} as TextContent,
						],
					};
				}
			}

			// Sort policies
			policySummaries.sort((a, b) => comparePolicySummaries(a, b, sortBy));

			// Apply pagination
			const { results: paginatedPolicies, metadata } = paginateResults(policySummaries, {
				limit,
				defaultLimit: responsePresets.list.defaultLimit,
				maxLimit: responsePresets.list.maxLimit,
			});

			// Create response content
			const responseContent: string[] = [];

			// Add header with summary stats
			responseContent.push(createPaginationHeader(metadata, "Enrich Policies"));

			if (paginatedPolicies.length === 0) {
				responseContent.push("No enrich policies found.");
			} else if (summary) {
				// Summary mode - compact view
				responseContent.push(...buildSummaryModeContent(paginatedPolicies, policySummaries, metadata.total));
			} else {
				// Detailed mode - full policy information
				responseContent.push(...buildDetailedModeContent(paginatedPolicies, policies));
			}

			// Truncate response if needed
			const fullResponse = responseContent.join("\n");
			const { content: finalContent, truncated } = truncateResponse(fullResponse, {
				maxTokens: responsePresets.list.maxTokens,
			});

			if (truncated) {
				logger.warn(
					{
						originalLength: fullResponse.length,
						truncatedLength: finalContent.length,
					},
					"Enrich policy response truncated due to size",
				);
			}

			const duration = performance.now() - perfStart;
			if (duration > 5000) {
				logger.warn({ duration }, "Slow get enrich policy operation");
			}

			return {
				content: [{ type: "text", text: finalContent } as TextContent],
			};
		} catch (error) {
			// Error handling
			if (error instanceof z.ZodError) {
				throwZodValidationMcpError(error, args, createGetPolicyMcpError);
			}

			if (error instanceof Error) {
				if (error.message.includes("timeout") || error.message.includes("timed_out")) {
					throw createGetPolicyMcpError(`Operation timed out: ${error.message}`, {
						type: "timeout",
						details: { duration: performance.now() - perfStart },
					});
				}

				if (error.message.includes("not_found") || error.message.includes("resource_not_found_exception")) {
					throw createGetPolicyMcpError(`Enrich policy not found: ${args?.name || "unknown"}`, {
						type: "policy_not_found",
						details: { requestedName: args?.name },
					});
				}

				if (error.message.includes("parsing") || error.message.includes("invalid")) {
					throw createGetPolicyMcpError(`Policy parsing failed: ${error.message}`, {
						type: "parsing",
						details: { originalError: error.message },
					});
				}
			}

			throw createGetPolicyMcpError(error instanceof Error ? error.message : String(error), {
				type: "execution",
				details: {
					duration: performance.now() - perfStart,
					args,
				},
			});
		}
	};

	// Tool registration - READ operation
	// Tool registration using modern registerTool method

	server.registerTool(
		"elasticsearch_enrich_get_policy",

		{
			title: "Enrich Get Policy",

			description:
				"Get enrich policies from Elasticsearch with pagination and filtering. Best for data enrichment configuration, policy inspection, document enhancement workflows. Returns summarized or detailed policy information with configurable limits.",

			inputSchema: getPolicyValidator.shape,
		},

		getPolicyHandler,
	);
};

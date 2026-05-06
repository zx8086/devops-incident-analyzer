/* src/tools/ilm/put_lifecycle.ts */
/* FIXED: Uses Zod Schema instead of JSON Schema for MCP compatibility */

/* SIMPLIFIED VERSION: Direct JSON Schema + MCP Error Codes */

import type { Client, estypes } from "@elastic/elasticsearch";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { logger } from "../../utils/logger.js";
import { withSecurityValidation } from "../../utils/securityEnhancer.js";
import type { SearchResult, ToolRegistrationFunction } from "../types.js";

const phaseSchema = z
	.object({
		actions: z.record(z.string(), z.unknown()).optional(),
		min_age: z.string().optional(),
	})
	.passthrough();

// Flexible body schema that supports both wrapped and direct formats
const bodySchema = z.union([
	// Format 1: {policy: {phases: {...}}} - wrapped format
	z
		.object({
			policy: z
				.object({
					phases: z.record(z.string(), phaseSchema).optional(),
				})
				.passthrough(),
		})
		.passthrough(),
	// Format 2: {phases: {...}} - direct format
	z
		.object({
			phases: z.record(z.string(), phaseSchema).optional(),
		})
		.passthrough(),
]);

const putLifecycleValidator = z.object({
	policy: z.string().min(1, "Policy identifier cannot be empty"),
	body: bodySchema,
	masterTimeout: z.string().optional(),
	timeout: z.string().optional(),
});

type PutLifecycleParams = z.infer<typeof putLifecycleValidator>;

function createIlmPutLifecycleMcpError(
	error: Error | string,
	context: {
		type: "validation" | "execution" | "permission" | "policy_conflict";
		details?: unknown;
	},
): McpError {
	const message = error instanceof Error ? error.message : error;

	const errorCodeMap = {
		validation: ErrorCode.InvalidParams,
		execution: ErrorCode.InternalError,
		permission: ErrorCode.InvalidRequest,
		policy_conflict: ErrorCode.InvalidRequest,
	};

	return new McpError(errorCodeMap[context.type], `[elasticsearch_ilm_put_lifecycle] ${message}`, context.details);
}

export const registerPutLifecycleTool: ToolRegistrationFunction = (server: McpServer, esClient: Client) => {
	const putLifecycleHandler = async (args: PutLifecycleParams): Promise<SearchResult> => {
		const perfStart = performance.now();

		try {
			const params = putLifecycleValidator.parse(args);

			logger.debug(
				{
					policy: params.policy,
					hasBody: !!params.body,
					masterTimeout: params.masterTimeout,
					timeout: params.timeout,
				},
				"Creating/updating ILM policy",
			);

			// The validator accepts either { policy: { phases: ... } } (wrapped) or
			// { phases: ... } (direct). Both shapes are coerced to the SDK's IlmPolicy
			// (the inner { phases: ..., _meta?: ... } object) before being passed flat.
			const ilmPolicy =
				"policy" in params.body && params.body.policy
					? (params.body.policy as unknown as estypes.IlmPolicy)
					: (params.body as unknown as estypes.IlmPolicy);

			logger.debug(
				{
					policy: params.policy,
					hasPhases: "phases" in ilmPolicy,
				},
				"Elasticsearch ILM API call",
			);

			const result = await esClient.ilm.putLifecycle({
				name: params.policy,
				policy: ilmPolicy,
				master_timeout: params.masterTimeout,
				timeout: params.timeout,
			});

			const duration = performance.now() - perfStart;
			if (duration > 5000) {
				logger.warn({ duration, policy: params.policy }, "Slow ILM operation: put_lifecycle");
			}

			logger.info({ policy: params.policy }, "ILM policy created/updated successfully");

			// MCP-compliant success response
			return {
				content: [
					{
						type: "text",
						text: `**ILM Policy Created/Updated: ${params.policy}**

The Index Lifecycle Management policy has been successfully ${result.acknowledged ? "created or updated" : "processed"}.

**Next Steps**: The policy will apply to indices matching the configured patterns. Use \`elasticsearch_ilm_explain_lifecycle\` to check policy application.

Operation completed at: ${new Date().toISOString()}`,
					},
					{
						type: "text",
						text: JSON.stringify(
							{
								acknowledged: result.acknowledged || true,
								policy: params.policy,
								operation: "put_lifecycle",
								timestamp: new Date().toISOString(),
							},
							null,
							2,
						),
					},
				],
			};
		} catch (error) {
			// Standardized MCP error handling
			if (error instanceof z.ZodError) {
				throw createIlmPutLifecycleMcpError(`Validation failed: ${error.issues.map((e) => e.message).join(", ")}`, {
					type: "validation",
					details: { validationErrors: error.issues, providedArgs: args },
				});
			}

			if (error instanceof Error) {
				if (error.message.includes("security_exception")) {
					throw createIlmPutLifecycleMcpError("Insufficient permissions to create/update ILM policy", {
						type: "permission",
						details: { originalError: error.message },
					});
				}

				if (error.message.includes("version_conflict") || error.message.includes("policy_already_exists")) {
					throw createIlmPutLifecycleMcpError(`Policy conflict: ${error.message}`, {
						type: "policy_conflict",
						details: { suggestion: "Policy may already exist with different settings" },
					});
				}

				if (error.message.includes("parsing_exception") || error.message.includes("invalid_policy")) {
					throw createIlmPutLifecycleMcpError(`Invalid policy definition: ${error.message}`, {
						type: "validation",
						details: { suggestion: "Check policy structure and phase configurations" },
					});
				}
			}

			throw createIlmPutLifecycleMcpError(error instanceof Error ? error.message : String(error), {
				type: "execution",
				details: {
					duration: performance.now() - perfStart,
					args,
				},
			});
		}
	};

	// Custom security configuration for ILM JSON data
	const ilmSecurityConfig = {
		maxInputSize: 1024 * 1024, // 1MB for large policies
		enableInjectionDetection: true,
		enableXssProtection: true,
		enableCommandInjectionProtection: false, // Disable for JSON containing pipes
		sensitiveFields: ["password", "api_key", "apiKey", "secret", "token", "auth"],
		maxQueryComplexity: 200, // Higher for complex ILM policies
	};

	// Enhanced handler with custom security validation
	const secureHandler = withSecurityValidation(
		"elasticsearch_ilm_put_lifecycle",
		putLifecycleHandler,
		ilmSecurityConfig,
	);

	// Direct tool registration with flexible Zod schema matching validator
	// Tool registration using modern registerTool method

	server.registerTool(
		"elasticsearch_ilm_put_lifecycle",

		{
			title: "Ilm Put Lifecycle",

			description:
				"Create or update ILM policy. Define Index Lifecycle Management policy with automated transitions through hot, warm, cold, and delete phases. FIXED: Uses flexible Zod Schema supporting both wrapped ({policy: {phases: {...}}}) and direct ({phases: {...}}) formats for proper MCP parameter handling.",

			inputSchema: putLifecycleValidator.shape,
		},

		secureHandler,
	);
};

// src/tools/transform/put_transform.ts

import type { Client, estypes } from "@elastic/elasticsearch";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { logger } from "../../utils/logger.js";
import { withSecurityValidation } from "../../utils/securityEnhancer.js";
import type { SearchResult, ToolRegistrationFunction } from "../types.js";

const sourceSchema = z
	.object({
		index: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]).describe("Source index name(s). Required."),
		query: z.record(z.string(), z.unknown()).optional().describe("Optional Elasticsearch query to filter source docs."),
		runtime_mappings: z.record(z.string(), z.unknown()).optional().describe("Optional runtime field mappings."),
	})
	.passthrough();

const destSchema = z
	.object({
		index: z.string().min(1).describe("Destination index name. Required."),
		pipeline: z.string().optional().describe("Optional ingest pipeline applied to docs written to the destination."),
	})
	.passthrough();

export const putTransformValidator = z
	.object({
		transformId: z
			.string()
			.min(1, "transformId cannot be empty")
			.max(64, "transformId must be <= 64 characters")
			.regex(
				/^[a-z0-9][a-z0-9_-]*[a-z0-9]$/,
				"transformId must be lowercase alphanumeric/`-`/`_`, start/end alphanumeric",
			)
			.describe("Transform id. Lowercase alphanumeric + `-` + `_`. Must start and end with alphanumeric. <= 64 chars."),
		source: sourceSchema.describe("Source configuration."),
		dest: destSchema.describe("Destination configuration."),
		pivot: z
			.record(z.string(), z.unknown())
			.optional()
			.describe("Pivot config (mutually exclusive with `latest`). Defines `group_by` + aggregations."),
		latest: z
			.record(z.string(), z.unknown())
			.optional()
			.describe("Latest config (mutually exclusive with `pivot`). Defines `unique_key` + `sort` fields."),
		description: z.string().optional().describe("Free-text description."),
		frequency: z.string().optional().describe("Check interval for continuous transforms. Min 1s, max 1h."),
		sync: z
			.object({ time: z.object({ field: z.string(), delay: z.string().optional() }).passthrough() })
			.passthrough()
			.optional()
			.describe("If present, transform runs continuously. `{ time: { field, delay } }`."),
		settings: z
			.object({
				max_page_search_size: z.number().int().min(10).max(65536).optional(),
				docs_per_second: z.number().optional(),
				dates_as_epoch_millis: z.boolean().optional(),
				align_checkpoints: z.boolean().optional(),
				deduce_mappings: z.boolean().optional(),
				num_failure_retries: z.number().int().min(0).optional(),
			})
			.passthrough()
			.optional()
			.describe("Transform settings (page size, throttling, retries, etc.)."),
		retention_policy: z
			.object({ time: z.object({ field: z.string(), max_age: z.string() }).passthrough() })
			.passthrough()
			.optional()
			.describe("Retention policy: deletes from destination docs older than `max_age` measured by `field`."),
		_meta: z.record(z.string(), z.unknown()).optional().describe("Free-form metadata."),
		deferValidation: z
			.boolean()
			.optional()
			.describe("Skip create-time validations (still run when transform starts, minus privilege checks)."),
		timeout: z.string().optional().describe("Period to wait for a response."),
	})
	.refine((v) => Boolean(v.pivot) !== Boolean(v.latest), {
		message: "Exactly one of `pivot` or `latest` must be set.",
		path: ["pivot"],
	});

type PutTransformParams = z.infer<typeof putTransformValidator>;

function createPutTransformMcpError(
	error: Error | string,
	context: {
		type: "validation" | "execution" | "permission" | "already_exists" | "parsing";
		details?: unknown;
	},
): McpError {
	const message = error instanceof Error ? error.message : error;
	const errorCodeMap = {
		validation: ErrorCode.InvalidParams,
		execution: ErrorCode.InternalError,
		permission: ErrorCode.InvalidRequest,
		already_exists: ErrorCode.InvalidRequest,
		parsing: ErrorCode.InvalidParams,
	};
	return new McpError(errorCodeMap[context.type], `[elasticsearch_put_transform] ${message}`, context.details);
}

export const registerPutTransformTool: ToolRegistrationFunction = (server: McpServer, esClient: Client) => {
	const handler = async (args: PutTransformParams): Promise<SearchResult> => {
		const perfStart = performance.now();
		let params: PutTransformParams | undefined;
		try {
			params = putTransformValidator.parse(args);

			logger.debug({ transformId: params.transformId, mode: params.pivot ? "pivot" : "latest" }, "Creating transform");

			const result = await esClient.transform.putTransform({
				transform_id: params.transformId,
				defer_validation: params.deferValidation,
				timeout: params.timeout,
				source: params.source as estypes.TransformSource,
				dest: params.dest as estypes.TransformDestination,
				pivot: params.pivot as estypes.TransformPivot | undefined,
				latest: params.latest as estypes.TransformLatest | undefined,
				description: params.description,
				frequency: params.frequency,
				sync: params.sync as estypes.TransformSyncContainer | undefined,
				settings: params.settings as estypes.TransformSettings | undefined,
				retention_policy: params.retention_policy as estypes.TransformRetentionPolicyContainer | undefined,
				_meta: params._meta as estypes.Metadata | undefined,
			});

			const duration = performance.now() - perfStart;
			if (duration > 5000) {
				logger.warn({ duration, transformId: params.transformId }, "Slow transform op: put_transform");
			}

			logger.info({ transformId: params.transformId }, "Transform created");

			return {
				content: [
					{
						type: "text",
						text: `**Transform created: ${params.transformId}**\nmode=${params.pivot ? "pivot" : "latest"}\nacknowledged=${result.acknowledged}\n\nNext step: \`elasticsearch_start_transform\` to begin processing.`,
					},
					{
						type: "text",
						text: JSON.stringify(
							{
								acknowledged: result.acknowledged,
								transformId: params.transformId,
								operation: "put_transform",
								timestamp: new Date().toISOString(),
							},
							null,
							2,
						),
					},
				],
			};
		} catch (error) {
			if (error instanceof z.ZodError) {
				throw createPutTransformMcpError(`Validation failed: ${error.issues.map((e) => e.message).join(", ")}`, {
					type: "validation",
					details: { validationErrors: error.issues, providedArgs: args },
				});
			}
			if (error instanceof Error) {
				if (error.message.includes("security_exception")) {
					throw createPutTransformMcpError("Insufficient permissions to create transform", {
						type: "permission",
						details: { originalError: error.message },
					});
				}
				if (error.message.includes("resource_already_exists") || error.message.includes("already exists")) {
					throw createPutTransformMcpError(
						`Transform '${params?.transformId ?? "<unset>"}' already exists. Use \`elasticsearch_update_transform\` to modify, or \`elasticsearch_delete_transform\` first.`,
						{ type: "already_exists", details: { transformId: params?.transformId } },
					);
				}
				if (error.message.includes("parsing_exception") || error.message.includes("invalid_transform")) {
					throw createPutTransformMcpError(`Invalid transform definition: ${error.message}`, {
						type: "parsing",
						details: { suggestion: "Check pivot/latest, source.index, dest.index, frequency, retention_policy" },
					});
				}
			}
			throw createPutTransformMcpError(error instanceof Error ? error.message : String(error), {
				type: "execution",
				details: { duration: performance.now() - perfStart, args },
			});
		}
	};

	// Transform bodies can be large (complex pivot aggs, multiple runtime fields).
	const securityConfig = {
		maxInputSize: 1024 * 1024,
		enableInjectionDetection: true,
		enableXssProtection: true,
		enableCommandInjectionProtection: false,
		sensitiveFields: ["password", "api_key", "apiKey", "secret", "token", "auth"],
		maxQueryComplexity: 200,
	};

	const secureHandler = withSecurityValidation("elasticsearch_put_transform", handler, securityConfig);

	server.registerTool(
		"elasticsearch_put_transform",
		{
			title: "Put Transform",
			description:
				"Create an Elasticsearch transform (`PUT _transform/{id}`). WRITE OPERATION. Requires `source.index`, `dest.index`, and exactly one of `pivot` or `latest`. Add `sync.time` to make it continuous. Use `deferValidation=true` only when source/dest don't exist yet. After creating, call `elasticsearch_start_transform` to begin processing.",
			inputSchema: putTransformValidator.shape,
		},
		secureHandler,
	);
};

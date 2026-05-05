/* src/tools/analytics/index.ts */
import type { Client } from "@elastic/elasticsearch";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { logger } from "../../utils/logger.js";
import { OperationType } from "../../utils/readOnlyMode.js";
import { booleanField } from "../../utils/zodHelpers.js";

// Define analytics-specific error types
export class AnalyticsError extends Error {
	constructor(
		message: string,
		public readonly operation?: string,
	) {
		super(message);
		this.name = "AnalyticsError";
	}
}

export class TermVectorError extends AnalyticsError {
	constructor(index: string, id: string | undefined, reason: string) {
		super(`Failed to get term vectors for document ${id || "anonymous"} in index ${index}: ${reason}`, "term_vectors");
		this.name = "TermVectorError";
	}
}

export class MultiTermVectorError extends AnalyticsError {
	constructor(reason: string) {
		super(`Failed to get multi term vectors: ${reason}`, "multi_term_vectors");
		this.name = "MultiTermVectorError";
	}
}

const getTermVectorsSchema = z.object({
	index: z.string().min(1, "Index cannot be empty"),
	id: z.string().optional(),
	doc: z.object({}).passthrough().optional(),
	fields: z.array(z.string()).optional(),
	field_statistics: booleanField().optional(),
	offsets: booleanField().optional(),
	payloads: booleanField().optional(),
	positions: booleanField().optional(),
	term_statistics: booleanField().optional(),
	routing: z.string().optional(),
	version: z.number().optional(),
	version_type: z.enum(["internal", "external", "external_gte"]).optional(),
	filter: z.object({}).passthrough().optional(),
	per_field_analyzer: z.record(z.string(), z.string()).optional(),
	preference: z.string().optional(),
	realtime: booleanField().optional(),
});

export const getTermVectors = {
	name: "elasticsearch_get_term_vectors",
	description:
		"Get term vectors for a document in Elasticsearch. Best for text analysis, relevance tuning, similarity calculations. Use when you need to analyze term frequency, positions, and offsets for document text analysis in Elasticsearch.",
	inputSchema: getTermVectorsSchema.shape,
	operationType: OperationType.READ as const,
	handler: async (client: Client, args: z.infer<typeof getTermVectorsSchema>) => {
		try {
			logger.debug(
				{
					index: args.index,
					id: args.id,
					fields: args.fields,
					hasDoc: !!args.doc,
					fieldStatistics: args.field_statistics,
					termStatistics: args.term_statistics,
				},
				"Getting term vectors for document",
			);

			// Validate that either id or doc is provided
			if (!args.id && !args.doc) {
				throw new McpError(ErrorCode.InvalidRequest, 'Either "id" or "doc" parameter must be provided');
			}

			const result = await client.termvectors(
				{
					index: args.index,
					id: args.id,
					doc: args.doc,
					fields: args.fields,
					field_statistics: args.field_statistics,
					offsets: args.offsets,
					payloads: args.payloads,
					positions: args.positions,
					term_statistics: args.term_statistics,
					routing: args.routing,
					version: args.version,
					version_type: args.version_type,
					filter: args.filter,
					per_field_analyzer: args.per_field_analyzer,
					preference: args.preference,
					realtime: args.realtime,
				},
				{
					opaqueId: "elasticsearch_get_term_vectors",
				},
			);

			logger.debug(
				{
					index: args.index,
					id: args.id,
					termVectorsFound: !!result.term_vectors,
					fieldsAnalyzed: result.term_vectors ? Object.keys(result.term_vectors).length : 0,
				},
				"Term vectors retrieved successfully",
			);

			return {
				content: [
					{
						type: "text" as const,
						text: JSON.stringify(result, null, 2),
					},
				],
			};
		} catch (error) {
			logger.error(
				{
					error: error instanceof Error ? error.message : String(error),
					index: args.index,
					id: args.id,
				},
				"Failed to get term vectors",
			);

			if (error instanceof Error && error.message.includes("index_not_found")) {
				throw new McpError(ErrorCode.InvalidRequest, `Index not found: ${args.index}`);
			}

			if (error instanceof Error && error.message.includes("not found")) {
				throw new McpError(ErrorCode.InvalidRequest, `Document not found: ${args.id} in index ${args.index}`);
			}

			throw new McpError(
				ErrorCode.InternalError,
				`Failed to get term vectors: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	},
};

const getMultiTermVectorsSchema = z.object({
	index: z.string().optional(),
	docs: z
		.array(
			z.object({
				_id: z.string(),
				_index: z.string().optional(),
				_source: booleanField().optional(),
				fields: z.array(z.string()).optional(),
				field_statistics: booleanField().optional(),
				offsets: booleanField().optional(),
				payloads: booleanField().optional(),
				positions: booleanField().optional(),
				term_statistics: booleanField().optional(),
				routing: z.string().optional(),
				version: z.number().optional(),
				version_type: z.enum(["internal", "external", "external_gte"]).optional(),
			}),
		)
		.optional(),
	ids: z.array(z.string()).optional(),
});

export const getMultiTermVectors = {
	name: "elasticsearch_get_multi_term_vectors",
	description:
		"Get term vectors for multiple documents in Elasticsearch. Best for text analysis, similarity calculations, relevance tuning. Use when you need to analyze term frequency and position data for multiple documents in Elasticsearch indices.",
	inputSchema: getMultiTermVectorsSchema.shape,
	operationType: OperationType.READ as const,
	handler: async (client: Client, args: z.infer<typeof getMultiTermVectorsSchema>) => {
		try {
			logger.debug(
				{
					index: args.index,
					docsCount: args.docs?.length,
					idsCount: args.ids?.length,
				},
				"Getting multi term vectors",
			);

			// Validate that either docs or ids is provided
			if (!args.docs && !args.ids) {
				throw new McpError(ErrorCode.InvalidRequest, 'Either "docs" or "ids" parameter must be provided');
			}

			// If using ids, ensure index is provided
			if (args.ids && !args.index) {
				throw new McpError(ErrorCode.InvalidRequest, 'When using "ids" parameter, "index" must also be provided');
			}

			const result = await client.mtermvectors(
				{
					index: args.index,
					docs: args.docs?.map((doc) => ({
						_id: doc._id,
						_index: doc._index,
						_source: doc._source,
						fields: doc.fields,
						field_statistics: doc.field_statistics,
						offsets: doc.offsets,
						payloads: doc.payloads,
						positions: doc.positions,
						term_statistics: doc.term_statistics,
						routing: doc.routing,
						version: doc.version,
						version_type: doc.version_type,
					})),
					ids: args.ids,
				},
				{
					opaqueId: "elasticsearch_get_multi_term_vectors",
				},
			);

			logger.debug(
				{
					index: args.index,
					docsProcessed: result.docs?.length || 0,
				},
				"Multi term vectors retrieved successfully",
			);

			return {
				content: [
					{
						type: "text" as const,
						text: JSON.stringify(result, null, 2),
					},
				],
			};
		} catch (error) {
			logger.error(
				{
					error: error instanceof Error ? error.message : String(error),
					index: args.index,
					docsCount: args.docs?.length,
					idsCount: args.ids?.length,
				},
				"Failed to get multi term vectors",
			);

			if (error instanceof Error && error.message.includes("index_not_found")) {
				throw new McpError(ErrorCode.InvalidRequest, `Index not found: ${args.index}`);
			}

			throw new McpError(
				ErrorCode.InternalError,
				`Failed to get multi term vectors: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	},
};

export { registerTimestampAnalysisTool } from "./timestamp_analysis.js";
export const analyticsTools = [getTermVectors, getMultiTermVectors] as const;

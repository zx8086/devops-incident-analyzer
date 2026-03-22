/* src/tools/queryAnalysis/getDocumentTypeExamples.ts */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Bucket } from "couchbase";
import { z } from "zod";
import { logger } from "../../lib/logger";
import { documentTypeExamples } from "./analysisQueries";
import { executeAnalysisQuery } from "./queryAnalysisUtils";

export default (server: McpServer, bucket: Bucket) => {
	server.tool(
		"get_document_type_examples",
		"Get examples of document keys for each document type",
		{
			scope_name: z.string().optional().default("_default").describe("Scope name to query"),
			collection_name: z.string().optional().default("_default").describe("Collection name to query"),
			type_field: z.string().optional().default("documentType").describe("Field name that contains the document type"),
		},
		async ({ scope_name, collection_name, type_field }) => {
			logger.info("Getting document type examples", { scope_name, collection_name, type_field });

			// Modify query based on parameters
			let query = documentTypeExamples;

			// Replace scope and collection if specified
			if (scope_name !== "_default" || collection_name !== "_default") {
				query = query.replace(
					/FROM\s+default\._default\._default/,
					`FROM default.\`${scope_name}\`.\`${collection_name}\``,
				);
			}

			// Replace type field if specified
			if (type_field !== "documentType") {
				query = query.replace(/d\.documentType/g, `d.\`${type_field}\``);
			}

			return executeAnalysisQuery(bucket, query, "Document Type Examples");
		},
	);
};

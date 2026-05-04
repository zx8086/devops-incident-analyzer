// src/tools/queryAnalysis/getDocumentTypeExamples.ts

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Bucket } from "couchbase";
import { z } from "zod";
import { assertIdentifier } from "../../lib/identifiers";
import { logger } from "../../utils/logger";
import { documentTypeExamples } from "./analysisQueries";
import { executeAnalysisQuery } from "./queryAnalysisUtils";

export type DocumentTypeExamplesInput = {
	scope_name: string;
	collection_name: string;
	type_field: string;
};

// SIO-667: scope/collection/type_field are spliced as backtick-wrapped IDENTIFIERS,
// not literals -- N1QL named parameters can't bind identifiers, so the only safe
// option is whitelist validation before substitution.
export function buildQuery(input: DocumentTypeExamplesInput): {
	query: string;
	parameters: Record<string, unknown>;
} {
	const scope_name = assertIdentifier(input.scope_name, "scope_name");
	const collection_name = assertIdentifier(input.collection_name, "collection_name");
	const type_field = assertIdentifier(input.type_field, "type_field");

	let query = documentTypeExamples;

	if (scope_name !== "_default" || collection_name !== "_default") {
		query = query.replace(
			/FROM\s+default\._default\._default/,
			`FROM default.\`${scope_name}\`.\`${collection_name}\``,
		);
	}

	if (type_field !== "documentType") {
		query = query.replace(/d\.documentType/g, `d.\`${type_field}\``);
	}

	return { query, parameters: {} };
}

export default (server: McpServer, bucket: Bucket) => {
	server.tool(
		"capella_get_document_type_examples",
		"Get examples of document keys for each document type",
		{
			scope_name: z
				.string()
				.optional()
				.default("_default")
				.describe("Scope name to query (must match /^[A-Za-z_][A-Za-z0-9_]*$/)"),
			collection_name: z
				.string()
				.optional()
				.default("_default")
				.describe("Collection name to query (must match /^[A-Za-z_][A-Za-z0-9_]*$/)"),
			type_field: z
				.string()
				.optional()
				.default("documentType")
				.describe("Field name that contains the document type (must match /^[A-Za-z_][A-Za-z0-9_]*$/)"),
		},
		async (input) => {
			logger.info(input, "Getting document type examples");
			const { query, parameters } = buildQuery(input);
			return executeAnalysisQuery(bucket, query, "Document Type Examples", undefined, parameters);
		},
	);
};

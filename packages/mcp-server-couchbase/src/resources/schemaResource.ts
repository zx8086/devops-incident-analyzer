/* src/resources/schemaResource.ts */

import { type McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Bucket } from "couchbase";
import { logger } from "../lib/logger";
import { ResponseBuilder } from "../lib/responseBuilder";
import type { DocumentContent } from "../lib/types";

export function registerSchemaResource(server: McpServer, bucket: Bucket): void {
	server.resource(
		"collection-schema",
		new ResourceTemplate("schema://{scope}/{collection}", { list: undefined }),
		async (uri, { scope, collection }) => {
			try {
				logger.info("Fetching schema resource", { scope, collection });

				const collectionMgr = bucket.collections();
				const scopes = await collectionMgr.getAllScopes();
				const foundScope = scopes.find((s) => s.name === scope);

				if (!foundScope) {
					return ResponseBuilder.error(`Scope "${scope}" not found`);
				}

				const foundCollection = foundScope.collections.find((c) => c.name === collection);
				if (!foundCollection) {
					return ResponseBuilder.error(`Collection "${collection}" not found in scope "${scope}"`);
				}

				try {
					const result = await bucket
						.scope(scope)
						.query(`SELECT RAW META().id FROM \`${bucket.name}\`.\`${scope}\`.\`${collection}\` LIMIT 1`);

					const rows = await result.rows;

					if (rows && rows.length > 0) {
						const docId = rows[0];
						const docResult = await bucket.scope(scope).collection(collection).get(docId);

						const schemaText = formatDocumentAsSchema(docResult.content);
						return ResponseBuilder.markdown(schemaText);
					} else {
						return ResponseBuilder.error(`No documents found in ${scope}.${collection} to infer schema.`);
					}
				} catch (queryError) {
					if (queryError instanceof Error && queryError.message.includes("index")) {
						return ResponseBuilder.error(
							`Unable to query collection. You may need to create a primary index:\nCREATE PRIMARY INDEX ON \`${bucket.name}\`.\`${scope}\`.\`${collection}\`;`,
						);
					}
					throw queryError;
				}
			} catch (error) {
				logger.error("Error fetching schema resource", {
					error: error instanceof Error ? error.message : String(error),
					scope,
					collection,
				});

				return ResponseBuilder.error(
					"Error fetching schema resource",
					error instanceof Error ? error : new Error(String(error)),
				);
			}
		},
	);

	logger.info("Schema resource registered successfully");
}

function formatDocumentAsSchema(doc: DocumentContent): string {
	let schemaText = "# Schema\n\n";

	const formatField = (key: string, value: unknown, level: number = 0): string => {
		const indent = "  ".repeat(level);
		const type = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;

		let fieldText = `${indent}- **${key}**: ${type}`;

		if (type === "object" && value !== null && !Array.isArray(value)) {
			fieldText += "\n";
			for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
				fieldText += formatField(k, v, level + 1);
			}
		} else if (type === "array" && Array.isArray(value) && value.length > 0) {
			const firstItem = value[0];
			const itemType = typeof firstItem;

			if (itemType === "object" && firstItem !== null) {
				fieldText += ` of objects\n`;
				for (const [k, v] of Object.entries(firstItem as Record<string, unknown>)) {
					fieldText += formatField(`${key}[0].${k}`, v, level + 1);
				}
			} else {
				fieldText += ` of ${itemType}s\n`;
			}
		} else {
			fieldText += "\n";
		}

		return fieldText;
	};

	for (const [key, value] of Object.entries(doc)) {
		schemaText += formatField(key, value);
	}

	return schemaText;
}

// src/resources/schemaResource.ts

import { type McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Bucket } from "couchbase";
import { logger } from "../utils/logger";
import { ResponseBuilder } from "../lib/responseBuilder";
import type { DocumentContent } from "../lib/types";

export function registerSchemaResource(server: McpServer, bucket: Bucket): void {
	server.resource(
		"collection-schema",
		new ResourceTemplate("schema://{scope}/{collection}", { list: undefined }),
		async (uri, { scope, collection }) => {
			const scopeName = String(scope ?? "");
			const collectionName = String(collection ?? "");
			try {
				logger.info({ scope: scopeName, collection: collectionName }, "Fetching schema resource");

				const collectionMgr = bucket.collections();
				const scopes = await collectionMgr.getAllScopes();
				const foundScope = scopes.find((s) => s.name === scopeName);

				if (!foundScope) {
					return ResponseBuilder.error(`Scope "${scopeName}" not found`).buildResourceResponse(uri.href);
				}

				const foundCollection = foundScope.collections.find((c) => c.name === collectionName);
				if (!foundCollection) {
					return ResponseBuilder.error(
						`Collection "${collectionName}" not found in scope "${scopeName}"`,
					).buildResourceResponse(uri.href);
				}

				try {
					const result = await bucket
						.scope(scopeName)
						.query(`SELECT RAW META().id FROM \`${bucket.name}\`.\`${scopeName}\`.\`${collectionName}\` LIMIT 1`);

					const rows = await result.rows;

					if (rows && rows.length > 0) {
						const docId = rows[0];
						const docResult = await bucket.scope(scopeName).collection(collectionName).get(docId);

						const schemaText = formatDocumentAsSchema(docResult.content);
						return ResponseBuilder.markdown(schemaText).buildResourceResponse(uri.href);
					}
					return ResponseBuilder.error(
						`No documents found in ${scopeName}.${collectionName} to infer schema.`,
					).buildResourceResponse(uri.href);
				} catch (queryError) {
					if (queryError instanceof Error && queryError.message.includes("index")) {
						return ResponseBuilder.error(
							`Unable to query collection. You may need to create a primary index:\nCREATE PRIMARY INDEX ON \`${bucket.name}\`.\`${scopeName}\`.\`${collectionName}\`;`,
						).buildResourceResponse(uri.href);
					}
					throw queryError;
				}
			} catch (error) {
				logger.error(
					{
						error: error instanceof Error ? error.message : String(error),
						scope: scopeName,
						collection: collectionName,
					},
					"Error fetching schema resource",
				);

				return ResponseBuilder.error(
					"Error fetching schema resource",
					error instanceof Error ? error : new Error(String(error)),
				).buildResourceResponse(uri.href);
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
				fieldText += " of objects\n";
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

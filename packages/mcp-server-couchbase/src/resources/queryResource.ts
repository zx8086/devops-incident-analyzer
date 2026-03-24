// src/resources/queryResource.ts

import { type McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Bucket } from "couchbase";
import { logger } from "../lib/logger";
import { ResponseBuilder } from "../lib/responseBuilder";
import { sqlppParser } from "../lib/sqlppParser";

export function registerQueryResource(server: McpServer, bucket: Bucket): void {
	server.resource(
		"query-results",
		new ResourceTemplate("query://{scope}/{encodedQuery}", { list: undefined }),
		async (uri, { scope, encodedQuery }) => {
			const scopeName = String(scope ?? "");
			const encodedQueryStr = String(encodedQuery ?? "");
			try {
				const query = decodeURIComponent(encodedQueryStr);
				logger.info({ scope: scopeName, query }, "Executing query resource");

				try {
					const scopes = await bucket.collections().getAllScopes();
					const foundScope = scopes.find((s) => s.name === scopeName);

					if (!foundScope) {
						return ResponseBuilder.error(`Scope not found: ${scopeName}`).buildResourceResponse(uri.href);
					}

					const upperQuery = query.trim().toUpperCase();
					if (!upperQuery.startsWith("SELECT")) {
						return ResponseBuilder.error(
							"Only SELECT queries are allowed via the query resource",
						).buildResourceResponse(uri.href);
					}

					let safeQuery = query;
					if (!upperQuery.includes("LIMIT")) {
						safeQuery = `${query} LIMIT 100`;
					}

					const parsedQuery = sqlppParser.parse(safeQuery);
					if (sqlppParser.modifiesData(parsedQuery) || sqlppParser.modifiesStructure(parsedQuery)) {
						return ResponseBuilder.error(
							"Modification queries are not allowed via the query resource",
						).buildResourceResponse(uri.href);
					}

					const result = await bucket.scope(scopeName).query(safeQuery);
					const rows = await result.rows;

					return ResponseBuilder.success(rows, "json").buildResourceResponse(uri.href);
				} catch (queryError) {
					if (queryError instanceof Error) {
						return ResponseBuilder.error("Query execution failed", queryError).buildResourceResponse(uri.href);
					}
					throw queryError;
				}
			} catch (error) {
				logger.error(
					{
						error: error instanceof Error ? error.message : String(error),
						scope: scopeName,
						encodedQuery: encodedQueryStr,
					},
					"Error executing query resource",
				);

				return ResponseBuilder.error(
					"Error executing query",
					error instanceof Error ? error : new Error(String(error)),
				).buildResourceResponse(uri.href);
			}
		},
	);

	logger.info("Query resource registered successfully");
}

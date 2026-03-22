/* src/lib/runSqlPlusPlusQuery.ts */

import { config } from "../config";
import { createError } from "./errors";
import { createContextLogger, logger, measureOperation } from "./logger";
import type { SQLPPParser } from "./sqlppParser";
import type { OperationContext, QueryResult } from "./types";

export async function runSqlPlusPlusQuery(
	ctx: OperationContext,
	scopeName: string,
	query: string,
	sqlppParser: SQLPPParser,
): Promise<QueryResult> {
	const requestLogger = createContextLogger("runSqlPlusPlusQuery");

	if (!ctx.lifespanContext.bucket) {
		requestLogger.error("Bucket not initialized");
		throw createError("DB_ERROR", "Bucket not initialized");
	}

	requestLogger.info("Executing SQL++ query", {
		scope: scopeName,
		queryLength: query.length,
	});

	// Warn if the query references a dot, which may indicate an incorrect path
	if (/from\s+[`\w]+\.[`\w]+\.[`\w]+/i.test(query)) {
		requestLogger.warn(
			"Query references bucket.scope.collection path. When using scope context, only use the collection name in the query.",
			{ query },
		);
	}

	const parsedQuery = sqlppParser.parse(query);

	// Check for data modification queries in read-only mode
	if (config.server.readOnlyQueryMode && sqlppParser.modifiesData(parsedQuery)) {
		requestLogger.warn("Data modification query rejected in read-only mode", {
			query,
			operation: "data_modification",
		});
		throw createError("QUERY_ERROR", "Data modification queries are not allowed in read-only mode");
	}

	// Check for structure modification queries in read-only mode
	if (config.server.readOnlyQueryMode && sqlppParser.modifiesStructure(parsedQuery)) {
		requestLogger.warn("Structure modification query rejected in read-only mode", {
			query,
			operation: "structure_modification",
		});
		throw createError("QUERY_ERROR", "Structure modification queries are not allowed in read-only mode");
	}

	// Add LIMIT clause if not present and maxResultsPerQuery is configured
	let safeQuery = query;
	if (config.server.maxResultsPerQuery && !parsedQuery.hasLimit) {
		safeQuery = `${query} LIMIT ${config.server.maxResultsPerQuery}`;
		requestLogger.debug("Added LIMIT clause to query", {
			originalQuery: query,
			modifiedQuery: safeQuery,
		});
	}

	try {
		return await measureOperation(
			"execute_query",
			async () => {
				requestLogger.debug("Executing query", { query: safeQuery });
				const result = await ctx.lifespanContext.bucket.scope(scopeName).query(safeQuery);
				const rows = await result.rows;

				requestLogger.info("Query executed successfully", {
					rowCount: rows.length,
					executionTime: result.meta?.executionTime,
				});

				return {
					rows,
					meta: result.meta,
				};
			},
			{
				scope: scopeName,
				query: safeQuery,
			},
		);
	} catch (error) {
		requestLogger.error("Query execution failed", {
			error: error instanceof Error ? error.message : String(error),
			query: safeQuery,
		});
		throw createError("QUERY_ERROR", "Failed to execute query", error);
	}
}

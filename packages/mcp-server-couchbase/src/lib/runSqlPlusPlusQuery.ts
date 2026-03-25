/* src/lib/runSqlPlusPlusQuery.ts */

import { config } from "../config";
import type { SQLPPParser } from "../types";
import { createError } from "./errors";
import { createContextLogger, measureOperation } from "./logger";
import type { OperationContext } from "./types";

interface RunQueryResult {
	rows: unknown[];
	meta?: unknown;
}

export async function runSqlPlusPlusQuery(
	ctx: OperationContext,
	scopeName: string,
	query: string,
	sqlppParser: SQLPPParser,
): Promise<RunQueryResult> {
	const requestLogger = createContextLogger("runSqlPlusPlusQuery");

	if (!ctx.lifespanContext.bucket) {
		requestLogger.error("Bucket not initialized");
		throw createError("DB_ERROR", "Bucket not initialized");
	}

	requestLogger.info(
		{
			scope: scopeName,
			queryLength: query.length,
		},
		"Executing SQL++ query",
	);

	// Warn if the query references a dot, which may indicate an incorrect path
	if (/from\s+[`\w]+\.[`\w]+\.[`\w]+/i.test(query)) {
		requestLogger.warn(
			{ query },
			"Query references bucket.scope.collection path. When using scope context, only use the collection name in the query.",
		);
	}

	const parsedQuery = sqlppParser.parse(query);

	// Check for data modification queries in read-only mode
	if (config.server.readOnlyQueryMode && sqlppParser.modifiesData(parsedQuery)) {
		requestLogger.warn(
			{
				query,
				operation: "data_modification",
			},
			"Data modification query rejected in read-only mode",
		);
		throw createError("QUERY_ERROR", "Data modification queries are not allowed in read-only mode");
	}

	// Check for structure modification queries in read-only mode
	if (config.server.readOnlyQueryMode && sqlppParser.modifiesStructure(parsedQuery)) {
		requestLogger.warn(
			{
				query,
				operation: "structure_modification",
			},
			"Structure modification query rejected in read-only mode",
		);
		throw createError("QUERY_ERROR", "Structure modification queries are not allowed in read-only mode");
	}

	// Add LIMIT clause if not present and maxResultsPerQuery is configured
	let safeQuery = query;
	if (config.server.maxResultsPerQuery && !parsedQuery.hasLimit) {
		safeQuery = `${query} LIMIT ${config.server.maxResultsPerQuery}`;
		requestLogger.debug(
			{
				originalQuery: query,
				modifiedQuery: safeQuery,
			},
			"Added LIMIT clause to query",
		);
	}

	try {
		return await measureOperation(
			"execute_query",
			async () => {
				requestLogger.debug({ query: safeQuery }, "Executing query");
				const result = await ctx.lifespanContext.bucket.scope(scopeName).query(safeQuery);
				const rows = await result.rows;

				requestLogger.info(
					{
						rowCount: rows.length,
						executionTime: result.meta?.metrics?.executionTime,
					},
					"Query executed successfully",
				);

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
		requestLogger.error(
			{
				error: error instanceof Error ? error.message : String(error),
				query: safeQuery,
			},
			"Query execution failed",
		);
		throw createError("QUERY_ERROR", "Failed to execute query", error instanceof Error ? error : undefined);
	}
}

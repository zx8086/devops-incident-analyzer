/* src/resources/queryResource.ts */

import {
  McpServer,
  ResourceTemplate,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import { logger } from "../lib/logger";
import type { Bucket } from "couchbase";
import { sqlppParser } from "../lib/sqlppParser";
import { ResponseBuilder } from "../lib/responseBuilder";
import type { QueryParams, QueryResult } from "../lib/types";
import { createError } from "../lib/errors";

export function registerQueryResource(server: McpServer, bucket: Bucket): void {
  server.resource(
    "query-results",
    new ResourceTemplate("query://{scope}/{encodedQuery}", { list: undefined }),
    async (uri, { scope, encodedQuery }) => {
      try {
        const query = decodeURIComponent(encodedQuery);
        logger.info("Executing query resource", { scope, query });

        try {
          const scopes = await bucket.collections().getAllScopes();
          const foundScope = scopes.find((s) => s.name === scope);
          
          if (!foundScope) {
            return ResponseBuilder.error(`Scope not found: ${scope}`);
          }

          const upperQuery = query.trim().toUpperCase();
          if (!upperQuery.startsWith("SELECT")) {
            return ResponseBuilder.error("Only SELECT queries are allowed via the query resource");
          }

          let safeQuery = query;
          if (!upperQuery.includes("LIMIT")) {
            safeQuery = `${query} LIMIT 100`;
          }

          const parsedQuery = sqlppParser.parse(safeQuery);
          if (
            sqlppParser.modifiesData(parsedQuery) ||
            sqlppParser.modifiesStructure(parsedQuery)
          ) {
            return ResponseBuilder.error("Modification queries are not allowed via the query resource");
          }

          const result = await bucket.scope(scope).query(safeQuery);
          const rows = await result.rows;

          return ResponseBuilder.success(rows, { type: 'json' });
        } catch (queryError) {
          if (queryError instanceof Error) {
            return ResponseBuilder.error("Query execution failed", queryError);
          }
          throw queryError;
        }
      } catch (error) {
        logger.error("Error executing query resource", {
          error: error instanceof Error ? error.message : String(error),
          scope,
          encodedQuery,
        });

        return ResponseBuilder.error(
          "Error executing query",
          error instanceof Error ? error : new Error(String(error))
        );
      }
    },
  );

  logger.info("Query resource registered successfully");
}

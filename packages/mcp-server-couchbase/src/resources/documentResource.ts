/* src/resources/documentResource.ts */

import {
  McpServer,
  ResourceTemplate,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import { logger } from "../lib/logger";
import type { Bucket } from "couchbase";
import { ResponseBuilder } from "../lib/responseBuilder";
import type { DocumentContent } from "../lib/types";
import { createError } from "../lib/errors";

export function registerDocumentResource(
  server: McpServer,
  bucket: Bucket,
): void {
  server.resource(
    "document",
    new ResourceTemplate("document://{scope}/{collection}/{id}", {
      list: undefined,
    }),
    async (uri, { scope, collection, id }) => {
      try {
        logger.info("Fetching document resource", {
          scope,
          collection,
          id,
        });

        try {
          const doc = await bucket.scope(scope).collection(collection).get(id);
          return ResponseBuilder.success(doc.content as DocumentContent, { type: 'json' });
        } catch (error) {
          if (error instanceof Error && error.message.includes('not found')) {
            return ResponseBuilder.error(`Document not found: ${id}`);
          }
          throw error;
        }
      } catch (error) {
        logger.error("Error fetching document resource", {
          error: error instanceof Error ? error.message : String(error),
          scope,
          collection,
          id,
        });

        return ResponseBuilder.error(
          "Error fetching document resource",
          error instanceof Error ? error : new Error(String(error))
        );
      }
    },
  );

  logger.info("Document resource registered successfully");
}

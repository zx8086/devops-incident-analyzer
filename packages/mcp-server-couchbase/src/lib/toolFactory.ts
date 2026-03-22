/* src/lib/toolFactory.ts */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Bucket } from "couchbase";
import { z } from "zod";
import { createContextLogger } from "./logger";
import { createError } from "./errors";

/**
 * Configuration interface for creating a tool
 * @template T - The Zod schema type for the tool's parameters
 */
export interface ToolConfig<T extends z.ZodType> {
  /** The name of the tool as it will be registered with the MCP server */
  name: string;
  /** A description of what the tool does */
  description: string;
  /** Zod schema defining the tool's parameter structure and validation */
  params: T;
  /** The handler function that implements the tool's functionality */
  handler: (params: z.infer<T>, bucket: Bucket) => Promise<any>;
}

/**
 * Creates a tool using the factory pattern
 * @template T - The Zod schema type for the tool's parameters
 * @param config - The tool configuration object
 * @returns A function that registers the tool with an MCP server
 * 
 * @example
 * ```typescript
 * const getDocumentTool = createTool({
 *   name: "get_document",
 *   description: "Get a document by ID",
 *   params: z.object({
 *     id: z.string()
 *   }),
 *   handler: async ({ id }, bucket) => {
 *     // Implementation
 *   }
 * });
 * ```
 */
export function createTool<T extends z.ZodType>(config: ToolConfig<T>) {
  return (server: McpServer, bucket: Bucket) => {
    const logger = createContextLogger(config.name);
    
    server.tool(
      config.name,
      config.description,
      config.params,
      async (params: z.infer<T>) => {
        try {
          logger.info(`Processing ${config.name}:`, params);
          
          if (!bucket) {
            throw createError("DB_ERROR", "Bucket is not initialized");
          }
          
          const result = await config.handler(params, bucket);
          
          logger.info(`${config.name} completed successfully`);
          return result;
        } catch (error) {
          logger.error(`Error in ${config.name}:`, error);
          throw error;
        }
      }
    );
  };
}

export function createToolConfig<T extends z.ZodType>(config: {
  name: string;
  description: string;
  params: T;
}) {
  return (handler: (params: z.infer<T>, bucket: Bucket) => Promise<any>) => {
    return (server: McpServer, bucket: Bucket) => {
      server.tool(
        config.name,
        config.description,
        config.params,
        async (params: z.infer<T>) => handler(params, bucket)
      );
    };
  };
} 
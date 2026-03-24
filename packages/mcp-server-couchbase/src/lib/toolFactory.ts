/* src/lib/toolFactory.ts */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Bucket } from "couchbase";
import type { z } from "zod";
import type { ToolResponse } from "../types";
import { createError } from "./errors";
import { createContextLogger } from "./logger";

/**
 * Configuration interface for creating a tool
 * @template T - The Zod schema type for the tool's parameters
 */
export interface ToolConfig<T extends z.ZodObject<z.ZodRawShape>> {
	/** The name of the tool as it will be registered with the MCP server */
	name: string;
	/** A description of what the tool does */
	description: string;
	/** Zod schema defining the tool's parameter structure and validation */
	params: T;
	/** The handler function that implements the tool's functionality */
	handler: (params: z.infer<T>, bucket: Bucket) => Promise<ToolResponse>;
}

export function createTool<T extends z.ZodObject<z.ZodRawShape>>(config: ToolConfig<T>) {
	return (server: McpServer, bucket: Bucket) => {
		const logger = createContextLogger(config.name);

		server.tool(config.name, config.description, config.params.shape, async (params: z.infer<T>) => {
			try {
				logger.info({ params }, `Processing ${config.name}`);

				if (!bucket) {
					throw createError("DB_ERROR", "Bucket is not initialized");
				}

				const result = await config.handler(params, bucket);

				logger.info(`${config.name} completed successfully`);
				return result;
			} catch (error) {
				logger.error({ error }, `Error in ${config.name}`);
				throw error;
			}
		});
	};
}

export function createToolConfig<T extends z.ZodObject<z.ZodRawShape>>(config: {
	name: string;
	description: string;
	params: T;
}) {
	return (handler: (params: z.infer<T>, bucket: Bucket) => Promise<ToolResponse>) => {
		return (server: McpServer, bucket: Bucket) => {
			server.tool(config.name, config.description, config.params.shape, async (params: z.infer<T>) =>
				handler(params, bucket),
			);
		};
	};
}

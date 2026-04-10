// src/lib/toolFactory.ts

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Bucket } from "couchbase";
import type { z } from "zod";
import type { ToolResponse } from "../types";
import { createContextLogger } from "../utils/logger";
import { createError } from "./errors";

export interface ToolConfig<T extends z.ZodObject<z.ZodRawShape>> {
	name: string;
	description: string;
	params: T;
	handler: (params: z.infer<T>, bucket: Bucket) => Promise<ToolResponse>;
}

export function createTool<T extends z.ZodObject<z.ZodRawShape>>(config: ToolConfig<T>) {
	return (server: McpServer, bucket: Bucket) => {
		const logger = createContextLogger(config.name);

		server.tool(config.name, config.description, config.params.shape, async (params) => {
			logger.debug({ params }, `Processing ${config.name}`);

			if (!bucket) {
				throw createError("DB_ERROR", "Bucket is not initialized");
			}

			return config.handler(params as z.infer<T>, bucket);
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
			server.tool(config.name, config.description, config.params.shape, async (params) =>
				handler(params as z.infer<T>, bucket),
			);
		};
	};
}

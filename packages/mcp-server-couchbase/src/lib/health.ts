/* src/lib/health.ts */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CapellaConn } from "../types";
import { logger } from "./logger";
import { createMcpError, MCP_ERROR_CODES } from "./mcpErrors";

export function registerHealthChecks(server: McpServer, capellaConn: CapellaConn): void {
	server.tool("health_check", "Check the health of the Couchbase MCP server", {}, async () => {
		logger.info("Running health check");

		try {
			if (!capellaConn.defaultBucket) {
				throw createMcpError(MCP_ERROR_CODES.INTERNAL_ERROR, "Couchbase connection not initialized");
			}

			await capellaConn.defaultBucket.collections().getAllScopes();

			return {
				content: [
					{
						type: "text",
						text: "✅ Server is healthy and connected to Couchbase",
					},
				],
			};
		} catch (error) {
			logger.error({ error }, "Health check failed");
			throw error;
		}
	});

	server.tool("get_diagnostics", "Get detailed server diagnostics", {}, async () => {
		logger.info("Running diagnostics");

		try {
			const diagnostics = {
				server: {
					status: "running",
					version: process.env.npm_package_version || "unknown",
					uptime: process.uptime(),
				},
				couchbase: {
					connected: !!capellaConn.defaultBucket,
					bucket: capellaConn.defaultBucket
						? {
								name: capellaConn.defaultBucket.name,
								scopes: await capellaConn.defaultBucket.collections().getAllScopes(),
							}
						: null,
				},
				system: {
					memory: process.memoryUsage(),
					cpu: process.cpuUsage(),
				},
			};

			return {
				content: [
					{
						type: "text",
						text: JSON.stringify(diagnostics, null, 2),
					},
				],
			};
		} catch (error) {
			logger.error({ error }, "Diagnostics failed");
			throw error;
		}
	});

	logger.info("Health checks registered successfully");
}

/* src/lib/pingHandler.ts */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { connectionManager } from "./connectionManager";
import { logger } from "../utils/logger";

export function registerPingHandlers(server: McpServer): void {
	server.tool("capella_ping", "Checks the server and database connection status", {}, async () => {
		try {
			logger.info("Protocol ping received");

			// Use the connection manager's health check
			if (!connectionManager.isConnectionHealthy()) {
				return {
					content: [
						{
							type: "text",
							text: "Server is running but not connected to a database.",
						},
					],
				};
			}
			// Optionally, try a lightweight ping
			try {
				const bucket = await connectionManager.getConnection();
				await bucket.ping();
				return {
					content: [
						{
							type: "text",
							text: "Server and database are healthy",
						},
					],
				};
			} catch (error) {
				logger.warn({ error }, "Database ping failed");
				return {
					content: [
						{
							type: "text",
							text: `Server is running but database connection failed. ${error instanceof Error ? error.message : String(error)}`,
						},
					],
				};
			}
		} catch (error) {
			logger.error({ error }, "Error during ping");
			return {
				content: [
					{
						type: "text",
						text: `Server error during ping. ${error instanceof Error ? error.message : String(error)}`,
					},
				],
			};
		}
	});

	logger.info("Ping handlers registered successfully");
}

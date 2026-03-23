/* src/lib/progressReporting.ts */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { logger } from "./logger";

export async function reportProgress(
	server: McpServer,
	token: string | number | undefined,
	progress: { percentage: number; message?: string },
): Promise<void> {
	if (!token) return;

	try {
		await server.notify("$/progress", {
			token,
			value: {
				percentage: progress.percentage,
				message: progress.message || `Operation ${progress.percentage}% complete`,
			},
		});

		logger.debug(
			{
				token,
				percentage: progress.percentage,
				message: progress.message,
			},
			"Progress reported",
		);
	} catch (error) {
		logger.error(
			{
				error,
				token,
				percentage: progress.percentage,
			},
			"Failed to report progress",
		);
	}
}

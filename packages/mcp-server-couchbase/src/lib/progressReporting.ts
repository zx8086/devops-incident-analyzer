// src/lib/progressReporting.ts

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { logger } from "./logger";

// McpServer does not expose a direct notify/sendNotification method.
// Progress is reported via logging. If SDK adds notification support in
// the future, this function can be updated to use it.
export async function reportProgress(
	_server: McpServer,
	token: string | number | undefined,
	progress: { percentage: number; message?: string },
): Promise<void> {
	if (!token) return;

	logger.debug(
		{
			token,
			percentage: progress.percentage,
			message: progress.message,
		},
		"Progress reported",
	);
}

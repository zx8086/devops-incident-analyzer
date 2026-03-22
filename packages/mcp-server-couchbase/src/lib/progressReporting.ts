/* src/lib/progressReporting.ts */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { logger } from "./logger";

export async function reportProgress(
  server: McpServer, 
  token: string | number | undefined, 
  progress: { percentage: number; message?: string }
): Promise<void> {
  if (!token) return;
  
  try {
    await server.notify('$/progress', {
      token,
      value: {
        percentage: progress.percentage,
        message: progress.message || `Operation ${progress.percentage}% complete`
      }
    });
    
    logger.debug('Progress reported', { 
      token, 
      percentage: progress.percentage,
      message: progress.message 
    });
  } catch (error) {
    logger.error('Failed to report progress', { 
      error,
      token,
      percentage: progress.percentage 
    });
  }
} 
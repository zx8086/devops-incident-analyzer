/* src/lib/toolRegistry.ts */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { toolRegistry } from "../tools";
import { logger } from "./logger";

export class ToolRegistry {
    private static registeredTools = new Set<string>();

    static registerAll(server: McpServer, bucket: any): void {
        Object.entries(toolRegistry).forEach(([name, toolFn]) => {
            this.registerTool(server, bucket, name, toolFn);
        });
        
        logger.info('All tools registered successfully', {
            toolCount: this.registeredTools.size,
            tools: Array.from(this.registeredTools)
        });
    }
    
    static registerTool(server: McpServer, bucket: any, name: string, toolFn: Function): void {
        if (this.registeredTools.has(name)) {
            logger.warn(`Tool already registered: ${name}`);
            return;
        }
        
        logger.info(`Registering tool: ${name}`);
        toolFn(server, bucket);
        this.registeredTools.add(name);
    }
} 
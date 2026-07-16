// agent/src/ticket-providers/bridge-invoker.ts
import { getToolsForDataSource } from "../mcp-bridge.ts";
import { normalizeToolContent } from "../sub-agent.ts";
import { type McpToolInvoker, TicketProviderError } from "./types.ts";

// In-process callers reuse the already-connected MCP bridge instead of dialing
// out (same principle as kg-topology and iac-reconcile). Tool lists refresh on
// the bridge's health-poll reconnect, so a restarted MCP server with a changed
// tool surface is picked up without an agent restart.
export function createBridgeToolInvoker(dataSourceId: string): McpToolInvoker {
	return {
		hasTool(toolName) {
			return getToolsForDataSource(dataSourceId).some((t) => t.name === toolName);
		},
		async invoke(toolName, args) {
			const tool = getToolsForDataSource(dataSourceId).find((t) => t.name === toolName);
			if (!tool) {
				throw new TicketProviderError(`Tool ${toolName} is not available on the ${dataSourceId} MCP server`);
			}
			return normalizeToolContent(await tool.invoke(args));
		},
	};
}

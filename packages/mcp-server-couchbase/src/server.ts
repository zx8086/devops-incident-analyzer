// src/server.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { config } from "./config";
import { registerPingHandlers } from "./lib/pingHandler";
import { ToolRegistry } from "./lib/toolRegistry";
import { registerSqlppQueryGenerator } from "./prompts/sqlppQueryGenerator";
import { registerAllResources } from "./resources";

export function createServer(bucket: import("couchbase").Bucket): McpServer {
	const server = new McpServer({
		name: config.server.name,
		version: config.server.version,
	});

	// Minimal hardcoded resource for debugging
	server.resource("test-playbook", "playbook://test.md", async (uri) => ({
		contents: [
			{
				uri: uri.href,
				mimeType: "text/markdown",
				text: "# Test",
			},
		],
	}));

	// Register all tools
	ToolRegistry.registerAll(server, bucket);

	// Register our SQL++ query generator prompt
	registerSqlppQueryGenerator(server);

	// Register all Couchbase resources
	registerAllResources(server, bucket);

	// Add a public method to read resources by URI
	// biome-ignore lint/suspicious/noExplicitAny: accessing internal MCP SDK resource registry
	const serverInternal = server as Record<string, any>;
	serverInternal.readResourceByUri = async (resourceUri: string) => {
		// Some SDK versions store resources as a Map (iterable), others as a plain object (not iterable).
		const resourceMap = serverInternal._resources || serverInternal.resources || serverInternal._registeredResources;
		if (!resourceMap) {
			console.error("No resource registry found on server instance.");
			throw new Error(
				"No resource registry found on server instance (tried _resources, resources, _registeredResources)",
			);
		}
		let resourcesIterable;
		if (resourceMap instanceof Map) {
			resourcesIterable = resourceMap.values();
		} else if (typeof resourceMap === "object") {
			resourcesIterable = Object.values(resourceMap);
		} else {
			throw new Error("Resource registry is not iterable");
		}
		for (const resource of resourcesIterable) {
			// Template match
			if (resource.template && resource.template.match) {
				const match = resource.template.match(resourceUri);
				if (match) {
					return await resource.handler({ href: resourceUri }, match);
				}
			}
			// Static URI match
			if (resource.uri && resource.uri === resourceUri) {
				return await resource.handler({ href: resourceUri }, {});
			}
		}
		throw new Error(`No resource handler found for URI: ${resourceUri}`);
	};

	// Register ping handlers for both protocol and tool usage
	registerPingHandlers(server);

	// Register a minimal echo tool for debugging
	function getDocLogger() {
		const { createContextLogger } = require("./lib/logger");
		return createContextLogger("EchoTool");
	}
	server.tool("echo", "Echoes back the input parameters for debugging", {}, async (params: Record<string, unknown>) => {
		getDocLogger().info("EchoTool RAW params", { raw_params: JSON.stringify(params) });
		return { content: [{ type: "text", text: JSON.stringify(params) }] };
	});

	return server;
}

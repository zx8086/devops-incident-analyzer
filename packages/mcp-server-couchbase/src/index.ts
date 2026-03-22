/* src/index.ts */

// Import global setup first
import './set-global';

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import type { Transport } from "@modelcontextprotocol/sdk/server/sse.js";
import type { CapellaConn, AppContext } from "./types";
import { AppError } from "./lib/errors";
import { config } from "./config";
import { logger } from "./lib/logger";
import { connectionManager } from "./lib/connectionManager";
import { ToolRegistry } from "./lib/toolRegistry";
import { registerResourceMethods } from "./lib/resources";
import { registerResources } from "./lib/resourceHandlers";
import { registerSqlppQueryGenerator } from "./prompts/sqlppQueryGenerator";
import { registerDatabaseStructureResource } from "./resources/databaseStructureResource";
import { registerAllResources } from "./resources";
import { registerPingHandlers } from "./lib/pingHandler";

// Application context setup
const appContext: AppContext = {
    readOnlyQueryMode: config.server.readOnlyQueryMode
};

export async function createServer(bucket: any): Promise<McpServer> {
    const server = new McpServer({
        name: config.server.name,
        version: config.server.version,
        capabilities: { 
            tools: {}, 
            resources: {},
            prompts: {}
        }
    });

    // Minimal hardcoded resource for debugging
    server.resource(
      "test-playbook",
      "playbook://test.md",
      async (uri) => ({
        contents: [{
          uri: uri.href,
          mimeType: "text/markdown",
          text: "# Test"
        }]
      })
    );

    // Register all tools
    ToolRegistry.registerAll(server, bucket);
    
    // Register our SQL++ query generator prompt
    registerSqlppQueryGenerator(server);
    
    // Register all Couchbase resources
    registerAllResources(server, bucket);

    // Add a public method to read resources by URI
    (server as any).readResourceByUri = async function(resourceUri) {
        // Root cause explanation:
        // Some SDK versions store resources as a Map (iterable), others as a plain object (not iterable).
        // We must support both cases for compatibility.
        const resourceMap =
          (this as any)._resources ||
          (this as any).resources ||
          (this as any)._registeredResources;
        if (!resourceMap) {
            console.error("No resource registry found on server instance. Available keys:", Object.keys(this));
            throw new Error("No resource registry found on server instance (tried _resources, resources, _registeredResources)");
        }
        let resourcesIterable;
        if (resourceMap instanceof Map) {
            resourcesIterable = resourceMap.values();
        } else if (typeof resourceMap === 'object') {
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
    }.bind(server);

    // Register ping handlers for both protocol and tool usage
    registerPingHandlers(server);

    // Register a minimal echo tool for debugging
    function getDocLogger() {
        const { createContextLogger } = require("./lib/logger");
        return createContextLogger('EchoTool');
    }
    server.tool(
        "echo",
        {},
        async (params: any) => {
            getDocLogger().info("EchoTool RAW params", { raw_params: JSON.stringify(params) });
            return { content: [{ type: "text", text: JSON.stringify(params) }] };
        }
    );

    return server;
}

export async function startSSEServer(server: McpServer, port: number): Promise<void> {
    const http = await import("node:http");
    const getRawBody = (await import("raw-body")).default;

    const activeSessions = new Map<string, SSEServerTransport>();

    const httpServer = http.createServer(async (req, res) => {
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type");

        if (req.method === "OPTIONS") {
            res.writeHead(204);
            res.end();
            return;
        }

        if (req.url?.startsWith("/sse") && req.method === "GET") {
            const transport = new SSEServerTransport("/mcp", res);
            activeSessions.set(transport.sessionId, transport);
            res.on("close", () => activeSessions.delete(transport.sessionId));
            await server.connect(transport);
            return;
        }

        if (req.url?.startsWith("/mcp") && req.method === "POST") {
            const url = new URL(req.url, `http://localhost:${port}`);
            const sessionId = url.searchParams.get("sessionId");
            const transport = sessionId ? activeSessions.get(sessionId) : undefined;
            if (!transport) {
                res.writeHead(400, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ error: "Invalid or missing sessionId" }));
                return;
            }
            const body = await getRawBody(req);
            await transport.handlePostMessage(req, res, body);
            return;
        }

        if (req.url === "/health") {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ status: "ok" }));
            return;
        }

        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Not found" }));
    });

    await new Promise<void>((resolve) => {
        httpServer.listen(port, "0.0.0.0", () => resolve());
    });

    logger.info(`SSE HTTP server listening on port ${port}`);
}

export async function createTransport(deps: { transport: 'stdio' | 'sse', port?: number }): Promise<Transport | null> {
    if (deps.transport === 'sse') {
        return null; // SSE uses startSSEServer instead
    }
    return new StdioServerTransport();
}

function handleServerStartupError(error: unknown): never {
    logger.error(`Error starting server: ${error instanceof Error ? error.message : String(error)}`);
    throw error instanceof Error ? error : new Error(String(error));
}

export async function startServer(deps: { transport: 'stdio' | 'sse', port?: number }): Promise<void> {
    try {
        logger.info("Starting Couchbase MCP Server...");
        const bucket = await connectionManager.getConnection();
        const server = await createServer(bucket);
        const transport = await createTransport(deps);
        await server.connect(transport);
        logger.info(`Couchbase MCP Server running with ${deps.transport} transport`);
    } catch (error) {
        handleServerStartupError(error);
    }
}

export async function setupServer(): Promise<{
  server: McpServer;
  transport: Transport;
  bucket: any;
}> {
  const bucket = await connectionManager.getConnection();
  const server = await createServer(bucket);
  const transport = await createTransport({
    transport: 'stdio',
    port: 8080
  });
  return { server, transport, bucket };
}

// Exponential backoff with circuit breaker for Couchbase connection
async function connectWithBackoffAndCircuitBreaker(
  maxAttempts = 10,
  baseDelayMs = 1000,
  maxDelayMs = 30000,
  circuitBreakerThreshold = 5,
  circuitBreakerCooldownMs = 60000
) {
  let failures = 0;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await connectionManager.initialize();
      return; // Success!
    } catch (err) {
      failures++;
      logger.error(`Couchbase connection failed (attempt ${attempt}/${maxAttempts}): ${err instanceof Error ? err.message : String(err)}`);
      if (failures >= circuitBreakerThreshold) {
        logger.error(`Circuit breaker tripped. Pausing for ${circuitBreakerCooldownMs / 1000}s`);
        await sleep(circuitBreakerCooldownMs);
        failures = 0; // Reset after cooldown
      } else {
        const delay = Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs);
        await sleep(delay);
      }
    }
  }
  throw new Error('Failed to connect to Couchbase after multiple attempts');
}

async function main(): Promise<void> {
  try {
    const transportMode = (process.env.MCP_TRANSPORT ?? "stdio") as "stdio" | "sse";
    const port = Number(process.env.MCP_PORT) || 9082;

    logger.info("Starting Couchbase MCP Server...");

    // Initialize the connection manager with backoff and circuit breaker
    await connectWithBackoffAndCircuitBreaker();

    const bucket = await connectionManager.getConnection();
    const server = await createServer(bucket);

    if (transportMode === "sse") {
      await startSSEServer(server, port);
      logger.info(`Couchbase MCP Server running with SSE transport on port ${port}`);
    } else {
      const transport = new StdioServerTransport();
      await server.connect(transport);
      logger.info("Couchbase MCP Server running with stdio transport");
    }
  } catch (error) {
    logger.error(`Fatal error in main(): ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

// Handle uncaught errors
process.on('uncaughtException', (error) => {
  logger.error('Uncaught Exception:', { error: error.message, stack: error.stack });
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled Rejection:', { reason: reason instanceof Error ? reason.message : String(reason) });
  process.exit(1);
});

// Start the server
main().catch((error) => {
  logger.error(`Fatal error in main(): ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});

export function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}
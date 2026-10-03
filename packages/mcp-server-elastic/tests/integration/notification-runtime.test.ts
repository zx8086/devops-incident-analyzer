/* tests/integration/notification-runtime.test.ts */

/**
 * Integration test to verify notification system works in production runtime
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getConfig } from "../../src/config/index.js";
import { createElasticsearchMcpServer } from "../../src/server.js";
import { shouldSkipIntegrationTests } from "../utils/elasticsearch-client.js";

// SIO-865: createElasticsearchMcpServer connects to ES in beforeAll; gate so the
// suite skips offline instead of timing out (matches the other integration files).
describe.skipIf(shouldSkipIntegrationTests())("Notification Runtime Integration", () => {
	let server: McpServer;

	beforeAll(async () => {
		// Create server with test configuration
		const config = getConfig();
		server = await createElasticsearchMcpServer(config);
	});

	afterAll(async () => {
		if (server) {
			await server.close();
		}
	});

	test("should create server without notification API errors", async () => {
		expect(server).toBeDefined();
		expect(server.server).toBeDefined();

		// Verify the server has the notification capability
		expect(server.server.notification).toBeDefined();
		expect(typeof server.server.notification).toBe("function");
	});
});

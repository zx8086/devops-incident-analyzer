/* tests/health.test.ts */

import { beforeEach, describe, expect, test } from "bun:test";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CouchbaseError } from "couchbase";
import { registerHealthChecks } from "../src/lib/health";
import type { CapellaConn } from "../src/types";

describe("Health Check Tests", () => {
	let mockServer: any;
	let mockCapellaConn: CapellaConn;

	beforeEach(() => {
		mockServer = {
			tool: (name: string, description: string, schema: any, handler: Function) => {
				mockServer.registeredTools[name] = {
					description,
					schema,
					handler,
				};
			},
			registeredTools: {},
		};
		mockCapellaConn = {
			cluster: {} as any,
			defaultBucket: {
				collections: () => ({
					getAllScopes: async () => [],
				}),
			} as any,
			defaultScope: {} as any,
			defaultCollection: {} as any,
			bucket: () => ({}) as any,
			scope: () => ({}) as any,
			collection: () => ({}) as any,
			CouchbaseError,
		};
	});

	test("should register health check tool", () => {
		registerHealthChecks(mockServer as unknown as McpServer, mockCapellaConn);
		expect(mockServer.registeredTools["health_check"]).toBeDefined();
	});

	test("should handle health check with no bucket", async () => {
		registerHealthChecks(mockServer as unknown as McpServer, mockCapellaConn);
		const handler = mockServer.registeredTools["health_check"].handler;
		const result = await handler();
		expect(result.content[0].text).toContain("healthy");
	});
});

/* tests/health.test.ts */

import { beforeEach, describe, expect, test } from "bun:test";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CouchbaseError } from "couchbase";
import { registerHealthChecks } from "../src/lib/health";
import type { CapellaConn } from "../src/types";

describe("Health Check Tests", () => {
	let mockServer: {
		tool: (
			name: string,
			description: string,
			schema: Record<string, unknown>,
			handler: (...args: unknown[]) => unknown,
		) => void;
		registeredTools: Record<
			string,
			{ description: string; schema: Record<string, unknown>; handler: (...args: unknown[]) => unknown }
		>;
	};
	let mockCapellaConn: CapellaConn;

	beforeEach(() => {
		mockServer = {
			tool: (
				name: string,
				description: string,
				schema: Record<string, unknown>,
				handler: (...args: unknown[]) => unknown,
			) => {
				mockServer.registeredTools[name] = {
					description,
					schema,
					handler,
				};
			},
			registeredTools: {},
		};
		mockCapellaConn = {
			cluster: {} as unknown as import("couchbase").Cluster,
			defaultBucket: {
				collections: () => ({
					getAllScopes: async () => [],
				}),
			} as unknown as import("couchbase").Bucket,
			defaultScope: {} as unknown as import("couchbase").Scope,
			defaultCollection: {} as unknown as import("couchbase").Collection,
			bucket: () => ({}) as unknown as import("couchbase").Bucket,
			scope: () => ({}) as unknown as import("couchbase").Scope,
			collection: () => ({}) as unknown as import("couchbase").Collection,
			CouchbaseError,
		};
	});

	test("should register health check tool", () => {
		registerHealthChecks(mockServer as unknown as McpServer, mockCapellaConn);
		expect(mockServer.registeredTools.capella_health_check).toBeDefined();
	});

	test("should handle health check with no bucket", async () => {
		registerHealthChecks(mockServer as unknown as McpServer, mockCapellaConn);
		const handler = mockServer.registeredTools.capella_health_check.handler;
		const result = await handler();
		expect(result.content[0].text).toContain("healthy");
	});
});

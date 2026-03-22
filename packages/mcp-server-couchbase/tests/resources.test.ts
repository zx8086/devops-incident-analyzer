/* tests/resources.test.ts */

import { beforeEach, describe, expect, it, mock } from "bun:test";
// import { McpServer } from '@modelcontextprotocol/sdk';
import { getResourcesList, registerResourceMethods } from "../src/lib/resources";

describe("Resource Methods", () => {
	let mockServer: any;

	beforeEach(() => {
		mockServer = {
			tool: mock(() => {}),
			method: mock(() => {}),
		};
	});

	it("should register resources_list as a tool", () => {
		registerResourceMethods(mockServer as unknown as McpServer);

		expect(mockServer.tool).toHaveBeenCalledWith(
			"resources_list",
			expect.any(String),
			expect.any(Object),
			expect.any(Function),
		);
	});

	it("should return correct resources list", async () => {
		const resources = getResourcesList();
		expect(resources).toBeInstanceOf(Array);
		expect(resources).toHaveLength(4);

		// Verify each resource has required properties
		resources.forEach((resource) => {
			expect(resource).toHaveProperty("id");
			expect(resource).toHaveProperty("name");
			expect(resource).toHaveProperty("description");
			expect(resource).toHaveProperty("type");
			expect(resource).toHaveProperty("capabilities");
		});

		// Verify specific resources
		const resourceIds = resources.map((r) => r.id);
		expect(resourceIds).toContain("couchbase-database");
		expect(resourceIds).toContain("scopes-collections");
		expect(resourceIds).toContain("schema");
		expect(resourceIds).toContain("query-engine");
	});
});

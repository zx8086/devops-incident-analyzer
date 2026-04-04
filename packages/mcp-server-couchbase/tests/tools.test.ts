/* tests/tools.test.ts */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import toolRegistry from "../src/tools";
import { logger } from "../src/utils/logger";
import { testConfig } from "./test.config";
import { mockConnection, mockServer } from "./test.utils";

describe("Couchbase MCP Server Tool Tests", () => {
	let _testCtx: any;
	const TEST_DOC_ID = "mcp_test_doc";

	// Setup - runs before all tests
	beforeAll(async () => {
		try {
			logger.info("Setting up test environment...");

			// Create test context
			_testCtx = {
				lifespanContext: {
					bucket: mockConnection.defaultBucket,
					readOnlyQueryMode: testConfig.server.readOnlyQueryMode,
				},
			};

			// Register all tools with mock server
			Object.values(toolRegistry).forEach((registerTool) => {
				registerTool(mockServer as any, mockConnection.defaultBucket);
			});

			logger.info("Test environment setup complete");
		} catch (error) {
			logger.error(`Test setup failed: ${error instanceof Error ? error.message : String(error)}`);
			throw error;
		}
	});

	// Cleanup - runs after all tests
	afterAll(async () => {
		try {
			logger.info("Test environment cleanup complete");
		} catch (error) {
			logger.error(`Test cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	});

	// Tool Registration Tests
	describe("Tool Registration Tests", () => {
		test("should register all required tools", () => {
			const requiredTools = [
				"capella_get_scopes_and_collections",
				"capella_get_schema_for_collection",
				"capella_get_document_by_id",
				"capella_upsert_document_by_id",
				"capella_delete_document_by_id",
				"capella_run_sql_plus_plus_query",
			];

			requiredTools.forEach((toolName) => {
				expect(mockServer.registeredTools[toolName]).toBeDefined();
				expect(mockServer.registeredTools[toolName].handler).toBeDefined();
			});
		});
	});

	// Document Operations Tests
	describe("Document Operations Tests", () => {
		test("Document operations - upsert, get, delete sequence", async () => {
			// Get handlers
			const upsertHandler = mockServer.registeredTools.capella_upsert_document_by_id.handler;
			const getHandler = mockServer.registeredTools.capella_get_document_by_id.handler;
			const deleteHandler = mockServer.registeredTools.capella_delete_document_by_id.handler;

			// Test document content
			const testDoc = {
				text: "Couchbase Capella MCP Server",
				quote: "You can't trust quotes from the internet",
				author: "Abraham Lincoln",
				at: new Date().toISOString(),
			};

			// Upsert document
			const upsertResult = await upsertHandler({
				scope_name: "_default",
				collection_name: "_default",
				document_id: TEST_DOC_ID,
				document_content: JSON.stringify(testDoc),
			});

			expect(upsertResult).toBeDefined();
			expect(upsertResult.content[0].text).toContain("successfully upserted");

			// Get document
			const getResult = await getHandler({
				scope_name: "_default",
				collection_name: "_default",
				document_id: TEST_DOC_ID,
			});

			expect(getResult).toBeDefined();
			const parsed = JSON.parse(getResult.content[0].text);
			expect(parsed.text).toBe(testDoc.text);
			expect(parsed.author).toBe(testDoc.author);
			expect(parsed.quote).toBe(testDoc.quote);

			// Delete document
			const deleteResult = await deleteHandler({
				scope_name: "_default",
				collection_name: "_default",
				document_id: TEST_DOC_ID,
			});

			expect(deleteResult).toBeDefined();
			expect(deleteResult.content[0].text).toContain("successfully deleted");
		});

		test("should handle missing parameters", async () => {
			const getHandler = mockServer.registeredTools.capella_get_document_by_id.handler;
			const upsertHandler = mockServer.registeredTools.capella_upsert_document_by_id.handler;
			const deleteHandler = mockServer.registeredTools.capella_delete_document_by_id.handler;

			// Test get document
			await expect(getHandler({})).rejects.toThrow();
			// Test upsert document
			await expect(upsertHandler({})).rejects.toThrow();
			// Test delete document
			await expect(deleteHandler({})).rejects.toThrow();
		});

		test("should handle invalid document content", async () => {
			const handler = mockServer.registeredTools.capella_upsert_document_by_id.handler;

			await expect(
				handler({
					scope_name: "_default",
					collection_name: "_default",
					document_id: "test_doc",
					document_content: "invalid json",
				}),
			).rejects.toThrow();
		});
	});

	// SQL++ Query Tests
	describe("SQL++ Query Tests", () => {
		test("should execute read-only query", async () => {
			const queryHandler = mockServer.registeredTools.capella_run_sql_plus_plus_query.handler;
			const result = await queryHandler({
				scope_name: "_default",
				query: "SELECT META().id FROM `_default` LIMIT 1",
			});

			expect(result).toBeDefined();
			expect(result.content[0].text).toContain("[");
			const arr = JSON.parse(result.content[0].text);
			expect(Array.isArray(arr)).toBe(true);
		});
	});
});

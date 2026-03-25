/* tests/integration.test.ts */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer } from "../src/server";
import { logger } from "../src/lib/logger";
import toolRegistry from "../src/tools";
import { mockConnection, mockServer } from "./test.utils";

describe("Integration Tests", () => {
	let server: any;
	const TEST_DOC_ID = "integration_test_doc";

	beforeAll(async () => {
		// Register all tools with mock server
		Object.values(toolRegistry).forEach((registerTool) => {
			registerTool(mockServer as any, mockConnection.defaultBucket);
		});
		server = await createServer(mockConnection);
	});

	afterAll(async () => {
		logger.info("Test environment cleanup complete");
	});

	describe("Tool Interaction Tests", () => {
		test("should handle document lifecycle with schema validation", async () => {
			const upsertHandler = mockServer.registeredTools.capella_upsert_document_by_id.handler;
			const getHandler = mockServer.registeredTools.capella_get_document_by_id.handler;
			const schemaHandler = mockServer.registeredTools.capella_get_schema_for_collection.handler;
			const deleteHandler = mockServer.registeredTools.capella_delete_document_by_id.handler;

			// 1. Get schema first
			const schemaResult = await schemaHandler({
				scope_name: "_default",
				collection_name: "_default",
			});
			expect(schemaResult).toBeDefined();

			// 2. Create document
			const testDoc = {
				name: "Integration Test",
				created: new Date().toISOString(),
				status: "active",
				metadata: {
					version: 1,
					tags: ["test", "integration"],
				},
			};

			const createResult = await upsertHandler({
				scope_name: "_default",
				collection_name: "_default",
				document_id: TEST_DOC_ID,
				document_content: JSON.stringify(testDoc),
			});
			expect(createResult.content[0].text).toContain("successfully upserted");

			// 3. Read and verify document
			const readResult = await getHandler({
				scope_name: "_default",
				collection_name: "_default",
				document_id: TEST_DOC_ID,
			});
			expect(readResult).toBeDefined();
			// Parse and check the document
			const parsed = JSON.parse(readResult.content[0].text);
			expect(parsed.name).toBe("Integration Test");

			// 4. Delete document
			const deleteResult = await deleteHandler({
				scope_name: "_default",
				collection_name: "_default",
				document_id: TEST_DOC_ID,
			});
			expect(deleteResult.content[0].text).toContain("successfully deleted");
		});

		test("should handle query with document operations", async () => {
			const queryHandler = mockServer.registeredTools.capella_run_sql_plus_plus_query.handler;
			const upsertHandler = mockServer.registeredTools.capella_upsert_document_by_id.handler;
			const getHandler = mockServer.registeredTools.capella_get_document_by_id.handler;

			// 1. Create test documents
			const testDocs = Array(5)
				.fill(null)
				.map((_, i) => ({
					id: `test_doc_${i}`,
					value: i,
					timestamp: new Date().toISOString(),
				}));

			// Create documents
			await Promise.all(
				testDocs.map((doc) =>
					upsertHandler({
						scope_name: "_default",
						collection_name: "_default",
						document_id: doc.id,
						document_content: JSON.stringify(doc),
					}),
				),
			);

			// 2. Query documents
			const queryResult = await queryHandler({
				scope_name: "_default",
				query: "SELECT * FROM `_default` USE KEYS 'test_doc_3'",
			});
			expect(queryResult).toBeDefined();
			expect(queryResult.content[0].text).toContain("[");
			const arr = JSON.parse(queryResult.content[0].text);
			expect(Array.isArray(arr)).toBe(true);

			// 3. Verify individual documents
			for (const doc of testDocs) {
				const result = await getHandler({
					scope_name: "_default",
					collection_name: "_default",
					document_id: doc.id,
				});
				expect(result).toBeDefined();
				const parsed = JSON.parse(result.content[0].text);
				expect(parsed.id).toBe(doc.id);
			}
		});
	});

	describe("Server Lifecycle Tests", () => {
		test("should handle server initialization and cleanup", async () => {
			expect(server).toBeDefined();
		});

		test("should register all required tools and resources", async () => {
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

	describe("Error Recovery Tests", () => {
		test("should recover from failed operations", async () => {
			const upsertHandler = mockServer.registeredTools.capella_upsert_document_by_id.handler;
			const getHandler = mockServer.registeredTools.capella_get_document_by_id.handler;

			// 1. Try to create document with invalid JSON
			await expect(
				upsertHandler({
					scope_name: "_default",
					collection_name: "_default",
					document_id: TEST_DOC_ID,
					document_content: "invalid json",
				}),
			).rejects.toThrow();

			// 2. Verify document doesn't exist
			await expect(
				getHandler({
					scope_name: "_default",
					collection_name: "_default",
					document_id: TEST_DOC_ID,
				}),
			).rejects.toThrow();

			// 3. Create valid document
			const testDoc = { test: "recovery" };
			const createResult = await upsertHandler({
				scope_name: "_default",
				collection_name: "_default",
				document_id: TEST_DOC_ID,
				document_content: JSON.stringify(testDoc),
			});
			expect(createResult.content[0].text).toContain("successfully upserted");

			// 4. Verify document exists
			const getResult = await getHandler({
				scope_name: "_default",
				collection_name: "_default",
				document_id: TEST_DOC_ID,
			});
			expect(getResult).toBeDefined();
			const parsed = JSON.parse(getResult.content[0].text);
			expect(parsed.test).toBe("recovery");
		});
	});
});

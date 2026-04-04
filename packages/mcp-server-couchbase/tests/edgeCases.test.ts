/* tests/edgeCases.test.ts */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { logger } from "../src/utils/logger";
import toolRegistry from "../src/tools";
import { mockConnection, mockServer } from "./test.utils";

describe("Edge Cases and Error Scenarios", () => {
	const TEST_DOC_ID = "edge_case_test_doc";

	beforeAll(async () => {
		Object.values(toolRegistry).forEach((registerTool) => {
			registerTool(mockServer as any, mockConnection.defaultBucket);
		});
	});

	afterAll(async () => {
		if (mockConnection.defaultBucket) {
			const collection = mockConnection.defaultBucket.scope("_default").collection("_default");
			try {
				await collection.remove(TEST_DOC_ID);
			} catch (_error) {
				logger.info(`No test document to clean up: ${TEST_DOC_ID}`);
			}
			if (mockConnection.cluster) {
				await mockConnection.cluster.close();
			}
		}
	});

	describe("Concurrent Operations", () => {
		test("should handle concurrent operations on same document", async () => {
			const upsertHandler = mockServer.registeredTools.capella_upsert_document_by_id.handler;
			const getHandler = mockServer.registeredTools.capella_get_document_by_id.handler;

			// Create initial document
			await upsertHandler({
				scope_name: "_default",
				collection_name: "_default",
				document_id: TEST_DOC_ID,
				document_content: JSON.stringify({ counter: 0 }),
			});

			// Perform concurrent updates
			const concurrentUpdates = Array(3)
				.fill(null)
				.map((_, i) =>
					upsertHandler({
						scope_name: "_default",
						collection_name: "_default",
						document_id: TEST_DOC_ID,
						document_content: JSON.stringify({ counter: i + 1 }),
					}),
				);

			await Promise.all(concurrentUpdates);

			// Verify final state
			const result = await getHandler({
				scope_name: "_default",
				collection_name: "_default",
				document_id: TEST_DOC_ID,
			});

			expect(result).toBeDefined();
			expect(result.content).toBeDefined();
			const parsed = JSON.parse(result.content[0].text);
			expect(parsed.counter).toBeDefined();
		});
	});

	describe("Large Document Handling", () => {
		test("should handle large document operations", async () => {
			const upsertHandler = mockServer.registeredTools.capella_upsert_document_by_id.handler;
			const getHandler = mockServer.registeredTools.capella_get_document_by_id.handler;

			// Create a large document (1MB of data)
			const largeDoc = {
				data: "x".repeat(1024 * 1024),
				timestamp: new Date().toISOString(),
			};

			// Upsert large document
			const upsertResult = await upsertHandler({
				scope_name: "_default",
				collection_name: "_default",
				document_id: TEST_DOC_ID,
				document_content: JSON.stringify(largeDoc),
			});

			expect(upsertResult).toBeDefined();
			expect(upsertResult.content).toBeDefined();

			// Retrieve and verify large document
			const getResult = await getHandler({
				scope_name: "_default",
				collection_name: "_default",
				document_id: TEST_DOC_ID,
			});

			expect(getResult).toBeDefined();
			expect(getResult.content).toBeDefined();
			const parsed = JSON.parse(getResult.content[0].text);
			expect(parsed.data).toBe(largeDoc.data);
		});
	});

	describe("Malformed Data Handling", () => {
		test("should handle malformed JSON responses", async () => {
			const upsertHandler = mockServer.registeredTools.capella_upsert_document_by_id.handler;

			// Test with malformed JSON
			const malformedJson = "{invalid: json}";

			await expect(
				upsertHandler({
					scope_name: "_default",
					collection_name: "_default",
					document_id: TEST_DOC_ID,
					document_content: malformedJson,
				}),
			).rejects.toThrow();
		});

		test("should handle empty document content", async () => {
			const upsertHandler = mockServer.registeredTools.capella_upsert_document_by_id.handler;

			await expect(
				upsertHandler({
					scope_name: "_default",
					collection_name: "_default",
					document_id: TEST_DOC_ID,
					document_content: "",
				}),
			).rejects.toThrow();
		});
	});

	describe("Special Character Handling", () => {
		test("should handle documents with special characters", async () => {
			const upsertHandler = mockServer.registeredTools.capella_upsert_document_by_id.handler;
			const getHandler = mockServer.registeredTools.capella_get_document_by_id.handler;

			const specialCharsDoc = {
				text: "Special chars: !@#$%^&*()_+{}|:<>?",
				emoji: "🌟🎉✨",
				unicode: "你好世界",
				control: "\n\t\r",
			};

			// Upsert document with special characters
			await upsertHandler({
				scope_name: "_default",
				collection_name: "_default",
				document_id: TEST_DOC_ID,
				document_content: JSON.stringify(specialCharsDoc),
			});

			// Retrieve and verify
			const result = await getHandler({
				scope_name: "_default",
				collection_name: "_default",
				document_id: TEST_DOC_ID,
			});

			expect(result).toBeDefined();
			expect(result.content).toBeDefined();
			const parsed = JSON.parse(result.content[0].text);
			expect(parsed.text).toBe(specialCharsDoc.text);
			expect(parsed.emoji).toBe(specialCharsDoc.emoji);
			expect(parsed.unicode).toBe(specialCharsDoc.unicode);
		});
	});
});

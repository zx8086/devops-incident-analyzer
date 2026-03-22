/* tests/performance.test.ts */

import { expect, test, describe, beforeAll, afterAll } from "bun:test";
import { logger } from "../src/lib/logger";
import { mockConnection, mockServer } from "./test.utils";
import toolRegistry from "../src/tools";

describe("Performance Tests", () => {
  const TEST_DOC_ID = "perf_test_doc";
  const BATCH_SIZE = 100;
  const CONCURRENT_OPERATIONS = 50;

  beforeAll(async () => {
    Object.values(toolRegistry).forEach(registerTool => {
      registerTool(mockServer as any, mockConnection.defaultBucket);
    });
  });

  afterAll(async () => {
    if (mockConnection.defaultBucket) {
      const collection = mockConnection.defaultBucket.scope("_default").collection("_default");
      try {
        await collection.remove(TEST_DOC_ID);
      } catch (error) {
        logger.info(`No test document to clean up: ${TEST_DOC_ID}`);
      }
      if (mockConnection.cluster) {
        await mockConnection.cluster.close();
      }
    }
  });

  describe("Load Tests", () => {
    test("should handle batch document operations", async () => {
      const upsertHandler = mockServer.registeredTools["upsert_document_by_id"].handler;
      const getHandler = mockServer.registeredTools["get_document_by_id"].handler;
      
      const startTime = Date.now();
      
      // Create batch of documents
      const batchDocs = Array(BATCH_SIZE).fill(null).map((_, i) => ({
        id: `batch_doc_${i}`,
        value: i,
        timestamp: new Date().toISOString()
      }));

      // Upsert batch
      const upsertPromises = batchDocs.map(doc => 
        upsertHandler({
          scope_name: "_default",
          collection_name: "_default",
          document_id: doc.id,
          document_content: JSON.stringify(doc)
        })
      );

      const upsertResults = await Promise.all(upsertPromises);
      const upsertTime = Date.now() - startTime;

      // Verify all documents
      const getPromises = batchDocs.map(doc =>
        getHandler({
          scope_name: "_default",
          collection_name: "_default",
          document_id: doc.id
        })
      );

      const getResults = await Promise.all(getPromises);
      const totalTime = Date.now() - startTime;

      // Log performance metrics
      logger.info("Performance metrics", {
        batchSize: BATCH_SIZE,
        upsertTimeMs: upsertTime,
        totalTimeMs: totalTime,
        avgUpsertTimeMs: upsertTime / BATCH_SIZE,
        avgGetTimeMs: (totalTime - upsertTime) / BATCH_SIZE
      });

      // Verify results
      expect(upsertResults).toHaveLength(BATCH_SIZE);
      expect(getResults).toHaveLength(BATCH_SIZE);
      
      getResults.forEach((result, i) => {
        const contentLines = result.content[0].text.split("\n");
        const contentStart = contentLines.findIndex(line => line.trim() === "Content:") + 1;
        const content = JSON.parse(contentLines.slice(contentStart).join("\n").trim());
        expect(content).toMatchObject(batchDocs[i]);
      });
    });

    test("should handle concurrent operations", async () => {
      const upsertHandler = mockServer.registeredTools["upsert_document_by_id"].handler;
      const getHandler = mockServer.registeredTools["get_document_by_id"].handler;
      
      const startTime = Date.now();
      
      // Create concurrent operations
      const operations = Array(CONCURRENT_OPERATIONS).fill(null).map((_, i) => {
        const doc = {
          id: `concurrent_doc_${i}`,
          value: i,
          timestamp: new Date().toISOString()
        };
        
        return upsertHandler({
          scope_name: "_default",
          collection_name: "_default",
          document_id: doc.id,
          document_content: JSON.stringify(doc)
        });
      });

      const results = await Promise.all(operations);
      const totalTime = Date.now() - startTime;

      // Log performance metrics
      logger.info("Concurrent operations metrics", {
        concurrentOperations: CONCURRENT_OPERATIONS,
        totalTimeMs: totalTime,
        avgOperationTimeMs: totalTime / CONCURRENT_OPERATIONS
      });

      // Verify results
      expect(results).toHaveLength(CONCURRENT_OPERATIONS);
      results.forEach(result => {
        expect(result.content[0].text).toContain("successfully upserted");
      });
    });
  });

  describe("Query Performance Tests", () => {
    test("should handle complex queries efficiently", async () => {
      const queryHandler = mockServer.registeredTools["run_sql_plus_plus_query"].handler;
      const upsertHandler = mockServer.registeredTools["upsert_document_by_id"].handler;
      
      // Create test data
      const testDocs = Array(100).fill(null).map((_, i) => ({
        id: `query_doc_${i}`,
        value: i,
        category: i % 5,
        timestamp: new Date().toISOString()
      }));

      // Insert test data
      await Promise.all(testDocs.map(doc =>
        upsertHandler({
          scope_name: "_default",
          collection_name: "_default",
          document_id: doc.id,
          document_content: JSON.stringify(doc)
        })
      ));

      // Execute complex query
      const startTime = Date.now();
      const queryResult = await queryHandler({
        scope_name: "_default",
        query: `SELECT * FROM \`default\`._default._default USE KEYS 'query_doc_99'`
      });
      const queryTime = Date.now() - startTime;

      // Log performance metrics
      logger.info("Query performance metrics", {
        queryTimeMs: queryTime,
        resultSize: queryResult.content[0].text.length
      });

      expect(queryResult).toBeDefined();
      expect(queryResult.content[0].text).toContain("[");
      const arr = JSON.parse(queryResult.content[0].text);
      expect(Array.isArray(arr)).toBe(true);
    });
  });

  describe("Connection Pool Tests", () => {
    test("should handle connection pool exhaustion gracefully", async () => {
      const upsertHandler = mockServer.registeredTools["upsert_document_by_id"].handler;
      
      // Create many concurrent operations to test connection pool
      const operations = Array(200).fill(null).map((_, i) => {
        const doc = {
          id: `pool_test_${i}`,
          value: i,
          timestamp: new Date().toISOString()
        };
        
        return upsertHandler({
          scope_name: "_default",
          collection_name: "_default",
          document_id: doc.id,
          document_content: JSON.stringify(doc)
        });
      });

      const startTime = Date.now();
      const results = await Promise.allSettled(operations);
      const totalTime = Date.now() - startTime;

      // Log performance metrics
      logger.info("Connection pool test metrics", {
        totalOperations: operations.length,
        successfulOperations: results.filter(r => r.status === 'fulfilled').length,
        failedOperations: results.filter(r => r.status === 'rejected').length,
        totalTimeMs: totalTime
      });

      // Verify that most operations succeeded
      const successRate = results.filter(r => r.status === 'fulfilled').length / operations.length;
      expect(successRate).toBeGreaterThan(0.9); // 90% success rate
    });
  });
}); 
/* tests/tools.test.ts */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import toolRegistry from "../src/tools";
import { logger } from "../src/utils/logger";
import { testConfig } from "./test.config";
import { type MockBucket, type MockCluster, mockConnection, mockServer } from "./test.utils";

describe("Couchbase MCP Server Tool Tests", () => {
	let _testCtx: { lifespanContext: { bucket: unknown; readOnlyQueryMode: boolean } } | undefined;
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
				registerTool(mockServer as unknown as McpServer, mockConnection.defaultBucket);
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

// SIO-1107: handler tests for the adopted official-server tools.
describe("SIO-1107 Adopted Tool Tests", () => {
	const defaultBucket = mockConnection.defaultBucket as unknown as MockBucket;
	const cluster = mockConnection.cluster as unknown as MockCluster;

	type ToolResult = { content: Array<{ type: string; text: string }>; isError?: boolean };
	const call = async (name: string, input: Record<string, unknown>): Promise<ToolResult> => {
		const registered = mockServer.registeredTools[name];
		expect(registered).toBeDefined();
		return (await registered.handler(input)) as ToolResult;
	};

	beforeAll(() => {
		Object.values(toolRegistry).forEach((registerTool) => {
			registerTool(mockServer as unknown as McpServer, mockConnection.defaultBucket);
		});
	});

	beforeEach(() => {
		defaultBucket.scopeQueryStubs.length = 0;
		defaultBucket.scopeQueryCalls.length = 0;
		cluster.queryCalls.length = 0;
		cluster.bucketCalls.length = 0;
	});

	test("registers all six new tools", () => {
		for (const name of [
			"capella_get_buckets",
			"capella_get_cluster_health",
			"capella_explain_sql_plus_plus_query",
			"capella_get_index_advisor_recommendations",
			"capella_get_non_covering_index_queries",
			"capella_get_low_selectivity_queries",
		]) {
			expect(mockServer.registeredTools[name]).toBeDefined();
			expect(mockServer.registeredTools[name].handler).toBeDefined();
		}
	});

	test("capella_get_buckets returns bare JSON with default_bucket and all names", async () => {
		const result = await call("capella_get_buckets", {});
		const parsed = JSON.parse(result.content[0].text) as {
			default_bucket: string;
			buckets: Array<{ name: string }>;
		};
		expect(parsed.default_bucket).toBe("default");
		expect(parsed.buckets.map((b) => b.name)).toEqual(["default", "second-bucket"]);
	});

	test("capella_get_cluster_health pings the cluster by default and a bucket when named", async () => {
		const clusterResult = await call("capella_get_cluster_health", {});
		expect(JSON.parse(clusterResult.content[0].text).scope).toBe("cluster");

		const bucketResult = await call("capella_get_cluster_health", { bucket_name: "second-bucket" });
		expect(JSON.parse(bucketResult.content[0].text).scope).toBe("bucket:second-bucket");
		expect(cluster.bucketCalls).toContain("second-bucket");
	});

	test("capella_get_scopes_and_collections prepends the bucket header and routes bucket_name", async () => {
		const defaultResult = await call("capella_get_scopes_and_collections", {});
		expect(defaultResult.content[0].text).toContain("Bucket: default");
		expect(defaultResult.content[0].text).toContain("Scope: _default");

		const otherResult = await call("capella_get_scopes_and_collections", { bucket_name: "second-bucket" });
		expect(otherResult.content[0].text).toContain("Bucket: second-bucket");
		expect(cluster.bucketCalls).toContain("second-bucket");
	});

	test("capella_explain_sql_plus_plus_query rejects a mutation in read-only mode", async () => {
		const result = await call("capella_explain_sql_plus_plus_query", {
			scope_name: "_default",
			query: "DELETE FROM `_default`",
		});
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("read-only");
		// The rejection happens before any query is issued.
		expect(defaultBucket.scopeQueryCalls).toHaveLength(0);
	});

	test("capella_explain_sql_plus_plus_query runs EXPLAIN in scope context and analyzes the plan", async () => {
		defaultBucket.scopeQueryStubs.push({
			pattern: /^EXPLAIN\s/,
			rows: [
				{
					plan: {
						"#operator": "Sequence",
						"~children": [{ "#operator": "PrimaryScan3", keyspace: "dates" }],
					},
					text: "SELECT META().id FROM `dates`",
				},
			],
		});
		const result = await call("capella_explain_sql_plus_plus_query", {
			scope_name: "seasons",
			query: "SELECT META().id FROM `dates`",
		});
		expect(result.isError).toBeUndefined();
		expect(result.content[0].text).toContain("# Query Execution Plan");
		expect(result.content[0].text).toContain("[WARNING]");
		expect(result.content[0].text).toMatch(/primary scan/i);
		const recorded = defaultBucket.scopeQueryCalls.at(-1);
		expect(recorded?.scope).toBe("seasons");
		expect(recorded?.statement).toBe("EXPLAIN SELECT META().id FROM `dates`");
	});

	test("capella_get_index_advisor_recommendations binds the statement as a named parameter", async () => {
		defaultBucket.scopeQueryStubs.push({
			pattern: /ADVISOR\(\$advise_statement\)/,
			rows: [
				{
					advisor_result: {
						adviseinfo: {
							recommended_indexes: {
								indexes: [{ index_statement: "CREATE INDEX idx_reco ON dates(styleSeasonCodeFms)" }],
							},
						},
					},
				},
			],
		});
		const analyzed = "SELECT styleSeasonCodeAfs FROM dates WHERE styleSeasonCodeFms = '2022WISPSP'";
		const result = await call("capella_get_index_advisor_recommendations", {
			scope_name: "seasons",
			query: analyzed,
		});
		expect(result.isError).toBeUndefined();
		expect(result.content[0].text).toContain("Recommended Indexes");
		expect(result.content[0].text).toContain("CREATE INDEX idx_reco");
		const recorded = defaultBucket.scopeQueryCalls.at(-1);
		expect(recorded?.statement).toContain("$advise_statement");
		expect(recorded?.statement).not.toContain(analyzed);
		expect(recorded?.options?.parameters?.advise_statement).toBe(analyzed);
	});

	test("capella_get_schema_for_collection formats INFER flavors when INFER succeeds", async () => {
		defaultBucket.scopeQueryStubs.push({
			pattern: /^INFER\s/,
			rows: [
				[
					{
						"#docs": 42,
						Flavor: "documentType = 'order'",
						properties: { orderId: { type: "string", samples: ["o-1"] } },
					},
				],
			],
		});
		const result = await call("capella_get_schema_for_collection", {
			scope_name: "_default",
			collection_name: "_default",
		});
		expect(result.content[0].text).toContain("Collection Schema (INFER, sampled)");
		expect(result.content[0].text).toContain("Flavor 1");
		expect(result.content[0].text).toContain("orderId: string");
	});

	test("capella_get_schema_for_collection falls back to sampling when INFER fails", async () => {
		defaultBucket.scopeQueryStubs.push({ pattern: /^INFER\s/, error: new Error("INFER not supported") });
		await defaultBucket
			.scope("_default")
			.collection("_default")
			.upsert("schema_fallback_doc", { name: "fallback", active: true });
		const result = await call("capella_get_schema_for_collection", {
			scope_name: "_default",
			collection_name: "_default",
		});
		// The sampled-document header, NOT the INFER header (other test files may have
		// left documents in the shared mock bucket, so don't assert on specific fields).
		expect(result.content[0].text).toContain("Collection Schema");
		expect(result.content[0].text).not.toContain("(INFER, sampled)");
		// INFER was attempted first, then the SELECT fallback ran.
		const statements = defaultBucket.scopeQueryCalls.map((c) => c.statement);
		expect(statements.some((s) => s.startsWith("INFER "))).toBe(true);
		expect(statements.some((s) => s.startsWith("SELECT * FROM"))).toBe(true);
		await defaultBucket.scope("_default").collection("_default").remove("schema_fallback_doc");
	});

	test("capella_suggest_query_optimizations uses live ADVISOR + EXPLAIN when reachable", async () => {
		defaultBucket.scopeQueryStubs.push({
			pattern: /ADVISOR\(\$advise_statement\)/,
			rows: [
				{
					advisor_result: {
						recommended_indexes: { indexes: [{ index_statement: "CREATE INDEX idx_live ON users(age)" }] },
					},
				},
			],
		});
		defaultBucket.scopeQueryStubs.push({
			pattern: /^EXPLAIN\s/,
			rows: [{ plan: { "#operator": "PrimaryScan3", keyspace: "users" } }],
		});
		const result = await call("capella_suggest_query_optimizations", {
			query: "SELECT name FROM users WHERE age > 21",
		});
		expect(result.content[0].text).toContain("live cluster analysis");
		expect(result.content[0].text).toContain("CREATE INDEX idx_live");
		expect(result.content[0].text).toContain("Execution Plan Analysis");
		expect(result.content[0].text).not.toContain("Heuristic fallback");
	});

	test("capella_suggest_query_optimizations falls back to heuristics when the cluster path fails", async () => {
		defaultBucket.scopeQueryStubs.push({ pattern: /ADVISOR\(/, error: new Error("advisor unreachable") });
		defaultBucket.scopeQueryStubs.push({ pattern: /^EXPLAIN\s/, error: new Error("explain unreachable") });
		const result = await call("capella_suggest_query_optimizations", {
			query: "SELECT name FROM users WHERE age > 21",
		});
		expect(result.content[0].text).toContain("Heuristic fallback (cluster unavailable)");
		expect(result.content[0].text).toContain("Index Recommendations");
	});

	test("capella_get_non_covering_index_queries and low-selectivity run via cluster context with LIMIT", async () => {
		const nonCovering = await call("capella_get_non_covering_index_queries", { limit: 5 });
		expect(nonCovering.content[0].text).toContain("Queries Not Using a Covering Index");
		expect(cluster.queryCalls.at(-1)?.statement).toMatch(/LIMIT 5;$/);

		const lowSelectivity = await call("capella_get_low_selectivity_queries", { limit: 3 });
		expect(lowSelectivity.content[0].text).toContain("Queries With Low Index Selectivity");
		expect(cluster.queryCalls.at(-1)?.statement).toMatch(/LIMIT 3;$/);
	});
});

// src/v2/tools/core.ts
//
// SIO-1443: v2 port of the 9 core/database tools (bucket/cluster/schema reads, SQL++
// query/explain, single-document CRUD). Re-implemented against @modelcontextprotocol/server's
// registerTool config style -- v1's tool files (packages/mcp-server-couchbase/src/tools/*.ts)
// import McpServer from @modelcontextprotocol/sdk, a different package, so they are read as
// reference only, not imported. Handler bodies and Zod schemas are ported verbatim; only the
// server/registration plumbing changes. Annotations are hand-written per tool below (see
// tool-classification.ts's READ_ONLY_TOOLS/WRITE_TOOLS/DESTRUCTIVE_TOOLS for the source of
// truth) since couchbaseToolAnnotations() itself is v1-only (imports ToolAnnotations from the
// v1 SDK's types module).
//
// Exception to "reference only, not imported": adviseQuery, withLatencyMs, and
// buildExplainStatement are imported directly from their v1 source files (getIndexAdvisor.ts,
// getClusterHealth.ts, explainSqlPlusPlusQuery.ts). Each of those files' only
// @modelcontextprotocol/sdk reference is `import type { McpServer }`, erased at compile time, so
// importing their runtime exports does not pull in v1 SDK types. This keeps the latency_us ->
// latencyMs/latencyNs fix (SIO-1264) and the EXPLAIN-statement builder as single sources of truth
// instead of drifting local copies (SIO-1443 review finding).
import { buildToolErrorEnvelope } from "@devops-agent/shared";
import type { McpServer, RegisteredTool, ToolAnnotations } from "@modelcontextprotocol/server";
import type { Bucket, ScopeSpec } from "couchbase";
import { z } from "zod";
import { config } from "../../config";
import { adviseCouchbaseError } from "../../lib/adviseCouchbaseError";
import { classifyCouchbaseError, isNoIndexError } from "../../lib/classifyCouchbaseError";
import { connectionManager } from "../../lib/connectionManager";
import { AppError } from "../../lib/errors";
import { evaluateQueryPlan, formatPlanFindings } from "../../lib/queryPlan";
import { resolveBucket } from "../../lib/resolveBucket";
import { runSqlPlusPlusQuery } from "../../lib/runSqlPlusPlusQuery";
import { sqlppParser } from "../../lib/sqlppParser";
import { TtlCache } from "../../lib/ttlCache";
import { buildExplainStatement } from "../../tools/explainSqlPlusPlusQuery";
import { withLatencyMs } from "../../tools/getClusterHealth";
import { adviseQuery } from "../../tools/queryAnalysis/getIndexAdvisor";
import { logger } from "../../utils/logger";

const READ_ONLY_ANNOTATIONS: ToolAnnotations = { readOnlyHint: true, destructiveHint: false };
const WRITE_ANNOTATIONS: ToolAnnotations = { readOnlyHint: false, destructiveHint: false };
const DESTRUCTIVE_ANNOTATIONS: ToolAnnotations = { readOnlyHint: false, destructiveHint: true };

// SIO-1419 (v1 tool-classification.ts): capella_run_sql_plus_plus_query executes arbitrary
// SQL++, so its read-only-ness is exactly config.server.readOnlyQueryMode -- computed live at
// registration time (not a static literal like the other 8 tools) so a boot with the mode
// disabled honestly reports a writable (and potentially destructive) tool.
function sqlQueryAnnotations(): ToolAnnotations {
	const readOnly = config.server.readOnlyQueryMode;
	return { readOnlyHint: readOnly, destructiveHint: !readOnly };
}

// Same TTL/dedup posture as v1's getScopesAndCollections.ts -- topology changes rarely, but a
// short TTL keeps duplicate calls within one turn off the cluster while staying fresh.
const scopesCache = new TtlCache<ScopeSpec[]>(30_000);

export function registerCoreToolsV2(server: McpServer, tools: Map<string, RegisteredTool>): void {
	const getBuckets = server.registerTool(
		"capella_get_buckets",
		{
			description:
				"Get the names and settings of all accessible buckets in the cluster, plus which bucket is the configured default",
			inputSchema: z.object({}),
			annotations: READ_ONLY_ANNOTATIONS,
		},
		async () => {
			logger.info("Listing buckets in cluster");
			const bucket = await connectionManager.getConnection();
			try {
				const all = await bucket.cluster.buckets().getAllBuckets();
				const payload = {
					default_bucket: bucket.name,
					buckets: all.map((b) => ({
						name: b.name,
						bucketType: b.bucketType,
						ramQuotaMB: b.ramQuotaMB,
						numReplicas: b.numReplicas,
					})),
				};
				return { content: [{ type: "text" as const, text: JSON.stringify(payload) }] };
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				logger.error({ error: message }, "Failed to list buckets");
				return {
					content: [{ type: "text" as const, text: JSON.stringify({ error: message }) }],
					isError: true,
				};
			}
		},
	);
	tools.set("capella_get_buckets", getBuckets);

	const getClusterHealth = server.registerTool(
		"capella_get_cluster_health",
		{
			description:
				"Get cluster health and running services with per-service ping latency. Each service entry reports latencyMs (MILLISECONDS -- use this one) and latencyNs (nanoseconds, same value). Do not rescale them. Typical healthy values are single-digit to low-hundreds of ms for a remote cluster. Optionally scoped to a bucket.",
			inputSchema: z.object({
				bucket_name: z.string().optional().describe("Optional bucket to ping instead of the cluster"),
			}),
			annotations: READ_ONLY_ANNOTATIONS,
		},
		async (params) => {
			logger.info({ bucket: params.bucket_name }, "Getting cluster health");
			const bucket = await connectionManager.getConnection();
			try {
				const target = params.bucket_name ? resolveBucket(bucket, params.bucket_name) : bucket.cluster;
				const pingResult = await target.ping();
				const raw =
					typeof (pingResult as { toJSON?: () => unknown }).toJSON === "function"
						? (pingResult as { toJSON: () => unknown }).toJSON()
						: pingResult;
				const payload = {
					scope: params.bucket_name ? `bucket:${params.bucket_name}` : "cluster",
					ping: withLatencyMs(raw),
				};
				return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }] };
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				logger.error({ error: message, bucket: params.bucket_name }, "Cluster health ping failed");
				return {
					content: [{ type: "text" as const, text: JSON.stringify({ error: message }) }],
					isError: true,
				};
			}
		},
	);
	tools.set("capella_get_cluster_health", getClusterHealth);

	const getScopesAndCollections = server.registerTool(
		"capella_get_scopes_and_collections",
		{
			description: "Get all scopes and collections in a bucket (defaults to the configured bucket)",
			inputSchema: z.object({
				bucket_name: z.string().optional().describe("Optional bucket name (defaults to the configured bucket)"),
			}),
			annotations: READ_ONLY_ANNOTATIONS,
		},
		async (params) => {
			const bucket = await connectionManager.getConnection();
			const resolved = resolveBucket(bucket, params.bucket_name);
			const scopes = await scopesCache.getOrLoad(resolved.name, () => resolved.collections().getAllScopes());
			const scopesCollections: Record<string, string[]> = {};

			for (const scope of scopes) {
				scopesCollections[scope.name] = scope.collections.map((c) => c.name);
			}

			let formattedText = `Bucket: ${resolved.name}\n\n`;
			formattedText += "Here are all the scopes and collections in the bucket:\n\n";

			for (const [scope, collections] of Object.entries(scopesCollections)) {
				formattedText += `📁 Scope: ${scope}\n`;
				if (collections && collections.length > 0) {
					for (const collection of collections) {
						formattedText += `  └─ 📄 Collection: ${collection}\n`;
					}
				} else {
					formattedText += "  └─ (No collections)\n";
				}
				formattedText += "\n";
			}

			return { content: [{ type: "text" as const, text: formattedText }] };
		},
	);
	tools.set("capella_get_scopes_and_collections", getScopesAndCollections);

	const getSchemaForCollection = server.registerTool(
		"capella_get_schema_for_collection",
		{
			description:
				"Get the schema for a collection via INFER (samples many documents, no index required), falling back to single-document sampling",
			inputSchema: z.object({
				scope_name: z.string().describe("Name of the scope"),
				collection_name: z.string().describe("Name of the collection"),
				bucket_name: z.string().optional().describe("Optional bucket name (defaults to the configured bucket)"),
			}),
			annotations: READ_ONLY_ANNOTATIONS,
		},
		async (params) => {
			const { scope_name, collection_name, bucket_name } = params;
			logger.info(
				`getSchemaHandler called with scope_name=${scope_name}, collection_name=${collection_name}, bucket_name=${bucket_name ?? "(default)"}`,
			);

			const bucket = await connectionManager.getConnection();
			const resolved = resolveBucket(bucket, bucket_name);
			const collectionMgr = resolved.collections();
			const scopes = await collectionMgr.getAllScopes();
			const foundScope = scopes.find((s) => s.name === scope_name);
			if (!foundScope) {
				throw new Error(`Scope "${scope_name}" does not exist`);
			}
			const foundCollection = foundScope.collections.find((c) => c.name === collection_name);
			if (!foundCollection) {
				throw new Error(`Collection "${collection_name}" does not exist in scope "${scope_name}"`);
			}

			try {
				const inferResult = await resolved
					.scope(scope_name)
					.query(`INFER \`${collection_name}\` WITH {"sample_size": 100, "num_sample_values": 2}`);
				const inferRows = await inferResult.rows;
				const inferText = formatInferSchema(inferRows);
				if (inferText !== null) {
					return { content: [{ type: "text" as const, text: inferText }] };
				}
				logger.debug({ collection: collection_name }, "INFER returned an unexpected shape; falling back to sampling");
			} catch (inferErr: unknown) {
				logger.debug(
					{ error: inferErr instanceof Error ? inferErr.message : String(inferErr), collection: collection_name },
					"INFER unavailable; falling back to single-document sampling",
				);
			}

			try {
				const result = await resolved.scope(scope_name).query(`SELECT * FROM \`${collection_name}\` LIMIT 1`);
				const rows = await result.rows;

				if (rows.length === 0) {
					return {
						content: [{ type: "text" as const, text: "❌ No documents found in collection to infer schema" }],
					};
				}

				return { content: [{ type: "text" as const, text: formatSchema(rows[0] as Record<string, unknown>) }] };
			} catch (err: unknown) {
				if (isNoIndexError(err)) {
					return {
						content: [
							{
								type: "text" as const,
								text: "❌ Database error: index failure. Please create a primary index on this collection to enable schema inference. Example:\n\nCREATE PRIMARY INDEX ON `bucket`.`scope`.`collection`;",
							},
						],
					};
				}
				throw err;
			}
		},
	);
	tools.set("capella_get_schema_for_collection", getSchemaForCollection);

	const runSqlPlusPlus = server.registerTool(
		"capella_run_sql_plus_plus_query",
		{
			description: "Execute a SQL++ query against a specific scope in the Couchbase bucket",
			inputSchema: z.object({
				scope_name: z.string().describe("Name of the scope"),
				query: z
					.string()
					.describe("SQL++ query to execute. Use only the collection name in the FROM clause if using scope context."),
			}),
			annotations: sqlQueryAnnotations(),
		},
		async (params) => {
			const bucket = await connectionManager.getConnection();
			return runQuery(params, bucket);
		},
	);
	tools.set("capella_run_sql_plus_plus_query", runSqlPlusPlus);

	const explainSqlPlusPlus = server.registerTool(
		"capella_explain_sql_plus_plus_query",
		{
			description:
				"Get the execution plan for a SQL++ query (EXPLAIN) plus an automated plan analysis: index usage, covering vs fetch, primary-scan warnings. Does not execute the query.",
			inputSchema: z.object({
				scope_name: z.string().describe("Name of the scope to plan the query in"),
				query: z
					.string()
					.describe("SQL++ query to explain. Use only the collection name in the FROM clause (scope context)."),
				bucket_name: z.string().optional().describe("Optional bucket name (defaults to the configured bucket)"),
			}),
			annotations: READ_ONLY_ANNOTATIONS,
		},
		async (params) => {
			logger.info({ scope: params.scope_name, bucket: params.bucket_name }, "Explaining SQL++ query");
			const bucket = await connectionManager.getConnection();
			return explainQuery(params, bucket);
		},
	);
	tools.set("capella_explain_sql_plus_plus_query", explainSqlPlusPlus);

	const getDocumentById = server.registerTool(
		"capella_get_document_by_id",
		{
			description: "Get a document by ID from a specific scope and collection",
			inputSchema: z.object({
				scope_name: z.string().describe("Name of the scope"),
				collection_name: z.string().describe("Name of the collection"),
				document_id: z.string().describe("ID of the document to retrieve"),
			}),
			annotations: READ_ONLY_ANNOTATIONS,
		},
		async (params) => {
			const bucket = await connectionManager.getConnection();
			const { scope_name, collection_name, document_id } = params;
			try {
				const collection = bucket.scope(scope_name).collection(collection_name);
				const result = await collection.get(document_id);
				return { content: [{ type: "text" as const, text: JSON.stringify(result.content, null, 2) }], isError: false };
			} catch (error) {
				logger.error({ error, scope_name, collection_name, document_id }, "Failed to get document by id");
				const message = error instanceof Error ? error.message : String(error);
				const kind = classifyCouchbaseError(error);
				const envelope = buildToolErrorEnvelope({ kind, message: `Failed to get document by id: ${message}` });
				return { content: [{ type: "text" as const, text: JSON.stringify(envelope) }], isError: true };
			}
		},
	);
	tools.set("capella_get_document_by_id", getDocumentById);

	const upsertDocumentById = server.registerTool(
		"capella_upsert_document_by_id",
		{
			description: "Create or update a document with a specific ID",
			inputSchema: z.object({
				scope_name: z.string().describe("Name of the scope"),
				collection_name: z.string().describe("Name of the collection"),
				document_id: z.string().describe("ID of the document to create or update"),
				document_content: z.string().describe("JSON content of the document"),
			}),
			annotations: WRITE_ANNOTATIONS,
		},
		async (params) => {
			const bucket = await connectionManager.getConnection();
			const { scope_name, collection_name, document_id, document_content } = params;
			try {
				let content: unknown;
				try {
					content = JSON.parse(document_content);
				} catch (_e) {
					throw new Error("Invalid JSON content");
				}

				const collection = bucket.scope(scope_name).collection(collection_name);
				await collection.upsert(document_id, content);
				return {
					content: [
						{
							type: "text" as const,
							text: `Document ${document_id} successfully upserted in ${scope_name}/${collection_name}`,
						},
					],
					isError: false,
				};
			} catch (error) {
				logger.error({ error, scope_name, collection_name, document_id }, "Failed to upsert document by id");
				const message = error instanceof Error ? error.message : String(error);
				const kind = classifyCouchbaseError(error);
				const envelope = buildToolErrorEnvelope({ kind, message: `Failed to upsert document by id: ${message}` });
				return { content: [{ type: "text" as const, text: JSON.stringify(envelope) }], isError: true };
			}
		},
	);
	tools.set("capella_upsert_document_by_id", upsertDocumentById);

	const deleteDocumentById = server.registerTool(
		"capella_delete_document_by_id",
		{
			description: "Delete a document by ID from a specific scope and collection",
			inputSchema: z.object({
				scope_name: z.string().describe("Name of the scope"),
				collection_name: z.string().describe("Name of the collection"),
				document_id: z.string().describe("ID of the document to delete"),
			}),
			annotations: DESTRUCTIVE_ANNOTATIONS,
		},
		async (params) => {
			const bucket = await connectionManager.getConnection();
			const { scope_name, collection_name, document_id } = params;
			try {
				const collection = bucket.scope(scope_name).collection(collection_name);
				await collection.remove(document_id);
				return {
					content: [
						{
							type: "text" as const,
							text: `Document ${document_id} successfully deleted from ${scope_name}/${collection_name}`,
						},
					],
					isError: false,
				};
			} catch (error) {
				logger.error({ error, scope_name, collection_name, document_id }, "Failed to delete document by id");
				const message = error instanceof Error ? error.message : String(error);
				const kind = classifyCouchbaseError(error);
				const envelope = buildToolErrorEnvelope({ kind, message: `Failed to delete document by id: ${message}` });
				return { content: [{ type: "text" as const, text: JSON.stringify(envelope) }], isError: true };
			}
		},
	);
	tools.set("capella_delete_document_by_id", deleteDocumentById);
}

// Ported verbatim from getSchemaForCollection.ts (SIO-1168 backtick-escaping contract).
function backtickIdentifier(name: string): string {
	return `\`${name.replace(/`/g, "``")}\``;
}

// Exported for potential unit testing (Task 9), mirrors v1's formatSchema.
function formatSchema(doc: Record<string, unknown>): string {
	let formattedText = "📋 Collection Schema:\n\n";

	const formatField = (key: string, value: unknown, indent: number = 0): string => {
		const padding = "  ".repeat(indent);
		const type = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;

		let fieldText = `${padding}${backtickIdentifier(key)}: ${type}`;

		if (typeof value === "object" && value !== null) {
			if (Array.isArray(value)) {
				if (value.length > 0) {
					fieldText += `\n${padding}  Example: ${JSON.stringify(value)}`;
				}
			} else if (Object.keys(value as object).length > 0) {
				fieldText +=
					"\n" +
					Object.entries(value as object)
						.map(([k, v]) => formatField(k, v, indent + 1))
						.join("\n");
			}
		} else if (value !== null) {
			fieldText += ` (Example: ${JSON.stringify(value)})`;
		}

		return fieldText;
	};

	formattedText += Object.entries(doc)
		.map(([key, value]) => formatField(key, value))
		.join("\n");

	return formattedText;
}

// Ported verbatim from getSchemaForCollection.ts. Renders INFER output; returns null on shape
// drift so the caller falls back to single-document sampling instead of asserting a wrong schema.
function formatInferSchema(rows: unknown): string | null {
	if (!Array.isArray(rows) || rows.length === 0) return null;
	const flavors = Array.isArray(rows[0]) ? rows[0] : rows;
	if (!Array.isArray(flavors) || flavors.length === 0) return null;

	const renderType = (type: unknown): string => {
		if (typeof type === "string") return type;
		if (Array.isArray(type)) return type.filter((t) => typeof t === "string").join(" | ") || "unknown";
		return "unknown";
	};

	let text = "Collection Schema (INFER, sampled):\n";
	let renderedAny = false;
	flavors.forEach((flavor, i) => {
		if (flavor === null || typeof flavor !== "object") return;
		const record = flavor as Record<string, unknown>;
		const properties = record.properties;
		if (properties === null || typeof properties !== "object") return;
		renderedAny = true;

		const docs = typeof record["#docs"] === "number" ? ` (~${record["#docs"]} docs sampled)` : "";
		const flavorName = typeof record.Flavor === "string" && record.Flavor.length > 0 ? ` [${record.Flavor}]` : "";
		text += `\nFlavor ${i + 1}${flavorName}${docs}:\n`;

		for (const [field, spec] of Object.entries(properties as Record<string, unknown>)) {
			const escapedField = backtickIdentifier(field);
			if (spec === null || typeof spec !== "object") {
				text += `  ${escapedField}: unknown\n`;
				continue;
			}
			const specRecord = spec as Record<string, unknown>;
			const samples = Array.isArray(specRecord.samples) ? specRecord.samples.slice(0, 2) : [];
			const sampleText = samples.length > 0 ? ` (samples: ${JSON.stringify(samples)})` : "";
			text += `  ${escapedField}: ${renderType(specRecord.type)}${sampleText}\n`;
		}
	});
	return renderedAny ? text : null;
}

// Ported verbatim from runSqlPlusPlusQuery.ts.
async function runQuery(params: { scope_name: string; query: string }, bucket: Bucket) {
	if (!bucket) {
		return { content: [{ type: "text" as const, text: "Database error: bucket not found" }], isError: true };
	}

	const { scope_name, query } = params;

	if (/from\s+[`\w]+\.[`\w]+\.[`\w]+/i.test(query)) {
		logger.error(
			{ query },
			"Query uses full bucket.scope.collection path. When using scope context, only use the collection name in the query.",
		);
		const envelope = buildToolErrorEnvelope({
			kind: "bad-query",
			message:
				"Query uses a full bucket.scope.collection path in the FROM clause. Under scope context, reference only the collection name.",
			advice:
				"Drop the bucket.scope prefix from the FROM clause and pass the scope via the scope_name argument. " +
				'Example: scope_name="inventory", query="SELECT COUNT(*) FROM `airline`" (NOT FROM `bucket`.`inventory`.`airline`).',
		});
		return { content: [{ type: "text" as const, text: JSON.stringify(envelope) }], isError: true };
	}

	try {
		const result = await runSqlPlusPlusQuery({ lifespanContext: { bucket } }, scope_name, query, sqlppParser);
		const rows = result.rows as Record<string, unknown>[];
		const warnings = result.meta?.warnings;
		const warningsMeta = warnings && warnings.length > 0 ? { warnings } : {};

		if (rows.length === 1 && rows[0] !== undefined && "distinct_source_count" in rows[0]) {
			return {
				content: [{ type: "text" as const, text: `Found ${rows[0].distinct_source_count} distinct sources` }],
				_meta: { rowCount: 1, ...warningsMeta },
				isError: false,
			};
		}

		return {
			content: [{ type: "text" as const, text: JSON.stringify(rows, null, 2) }],
			_meta: { rowCount: rows.length, meta: result.meta, ...warningsMeta },
			isError: false,
		};
	} catch (error) {
		logger.error({ error: error instanceof Error ? error.message : String(error) }, "Failed to execute query");
		const cause = error instanceof AppError ? error.originalError : undefined;
		const message = cause?.message ?? (error instanceof Error ? error.message : String(error));
		const kind = classifyCouchbaseError(error);
		const advice = adviseCouchbaseError(kind);
		const envelope = buildToolErrorEnvelope({
			kind,
			message: `Failed to execute query: ${message}`,
			...(advice ? { advice } : {}),
		});
		return { content: [{ type: "text" as const, text: JSON.stringify(envelope) }], isError: true };
	}
}

// Ported verbatim from explainSqlPlusPlusQuery.ts. buildExplainStatement itself is imported
// directly from that file (see the import block above) rather than re-ported, closing one of the
// query-analysis helper triplication risks flagged in review.
async function explainQuery(params: { scope_name: string; query: string; bucket_name?: string }, bucket: Bucket) {
	const { scope_name, query, bucket_name } = params;

	if (/from\s+[`\w]+\.[`\w]+\.[`\w]+/i.test(query)) {
		return {
			content: [
				{
					type: "text" as const,
					text: "Error: Query uses full bucket.scope.collection path. When using scope context, only use the collection name in the query. For example: SELECT COUNT(*) FROM `_default`",
				},
			],
			isError: true,
		};
	}

	const inner = query.trim().replace(/^EXPLAIN\s+/i, "");
	const parsed = sqlppParser.parse(inner);
	if (config.server.readOnlyQueryMode && (sqlppParser.modifiesData(parsed) || sqlppParser.modifiesStructure(parsed))) {
		return {
			content: [
				{
					type: "text" as const,
					text: "Error: EXPLAIN of data/structure modification statements is not allowed in read-only mode",
				},
			],
			isError: true,
		};
	}

	const statement = buildExplainStatement(query);
	try {
		const resolved = resolveBucket(bucket, bucket_name);
		const result = await resolved.scope(scope_name).query(statement);
		const rows = await result.rows;
		const first = rows[0];
		const plan =
			first !== null && typeof first === "object" && "plan" in (first as Record<string, unknown>)
				? (first as Record<string, unknown>).plan
				: first;
		const findings = evaluateQueryPlan(plan);

		let text = "# Query Execution Plan\n\n";
		text += `## Statement\n\n\`\`\`sql\n${statement}\n\`\`\`\n\n`;
		text += `## Plan\n\n\`\`\`json\n${JSON.stringify(plan ?? null, null, 2)}\n\`\`\`\n\n`;
		text += `## Plan Analysis\n\n${formatPlanFindings(findings)}\n`;
		return { content: [{ type: "text" as const, text }] };
	} catch (error) {
		logger.error({ error, statement }, "Failed to explain query");
		const message = error instanceof Error ? error.message : String(error);
		const kind = classifyCouchbaseError(error);
		let advice = adviseCouchbaseError(kind);
		if (kind === "no-index") {
			try {
				const advisorResult = await adviseQuery({ scope_name, query: inner, bucket_name }, bucket);
				const advisorText = advisorResult.content[0]?.text;
				if (!advisorResult.isError && advisorText) {
					advice = `${advice ? `${advice} ` : ""}Index advisor recommendations:\n\n${advisorText}`;
				}
			} catch (advisorError) {
				logger.warn({ advisorError }, "Index advisor auto-enrichment failed; returning plain no-index advice");
			}
		}
		const envelope = buildToolErrorEnvelope({
			kind,
			message: `Failed to explain query: ${message}`,
			...(advice ? { advice } : {}),
		});
		return { content: [{ type: "text" as const, text: JSON.stringify(envelope) }], isError: true };
	}
}

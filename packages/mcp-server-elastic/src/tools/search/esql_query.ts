// src/tools/search/esql_query.ts
// SIO-1391: ES|QL query tool. A single `FROM ... | WHERE ... | STATS ... BY ...` collapses what
// otherwise takes a multi-step aggregation build, which matters against the per-invocation tool
// budget. Read-only by construction: ES|QL has no write commands.

import type { Client } from "@elastic/elasticsearch";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { logger } from "../../utils/logger.js";
import type { SearchResult, ToolRegistrationFunction } from "../types.js";

// CodeRabbit (PR #596): the description told the model to always LIMIT but nothing enforced it, and
// a no-LIMIT query really does return ES's default 1000 rows (verified live on eu-cld) -- a payload
// risk worth catching before the round-trip.
//
// Deliberately NOT the stricter "must END with LIMIT" rule that was proposed: verified live that
// these legitimate shapes have no trailing LIMIT and work fine --
//   `... | STATS c = COUNT(*)`        (UNGROUPED agg -> exactly 1 row)
//   `... | LIMIT 5 | SORT @timestamp` (LIMIT may appear mid-pipeline)
//   `... | limit 2`                   (ES|QL keywords are case-insensitive)
// Rejecting those would break working queries to enforce a style rule. Require only that a LIMIT
// appears SOMEWHERE, plus the narrow ungrouped-STATS exemption below.
const LIMIT_CLAUSE = /\|\s*limit\s+\d+/i;
// CodeRabbit round 2 (PR #596): the first exemption was too broad. Verified live on eu-cld:
//   `| STATS c = COUNT(*)`              -> 1 row      (safe to exempt)
//   `| STATS c = COUNT(*) BY service.name` -> 1000 rows  (one per GROUP -- hits the default cap)
//   `| INLINESTATS c = COUNT(*)`        -> 1000 rows  (annotates rows, never reduces them)
// So only an ungrouped STATS actually bounds the result. INLINESTATS never does.
// Split on pipes and inspect each stage on its own rather than writing one clever regex over the
// whole query -- an earlier single-regex attempt silently accepted `| STATS ... BY service.name`,
// the exact case this is meant to reject.
const STATS_STAGE = /^\s*stats\s/i;
const BY_CLAUSE = /\sby\s/i;

function hasUngroupedStats(query: string): boolean {
	return query.split("|").some((stage) => STATS_STAGE.test(stage) && !BY_CLAUSE.test(stage));
}

function requiresExplicitLimit(query: string): boolean {
	return !LIMIT_CLAUSE.test(query) && !hasUngroupedStats(query);
}

const esqlQueryValidator = z.object({
	query: z
		.string()
		.min(1)
		.refine((q) => !requiresExplicitLimit(q), {
			message:
				"ES|QL query must include a `| LIMIT <n>` clause. Only an UNGROUPED `| STATS` (no `BY`) is exempt, since it returns a single row -- `STATS ... BY <field>` and `INLINESTATS` do not bound the row count. Without a LIMIT, Elasticsearch returns its default 1000 rows.",
		})
		.describe(
			"ES|QL query string. Starts with a source command (FROM/ROW/SHOW) and pipes through operators, e.g. 'FROM logs-* | WHERE log.level == \"error\" | STATS count = COUNT(*) BY service.name | SORT count DESC | LIMIT 10'. Must include a `| LIMIT <n>` clause unless the pipeline ends in an UNGROUPED `| STATS` (no `BY`), which returns a single row. `STATS ... BY <field>` and `INLINESTATS` still need a LIMIT -- without one Elasticsearch returns its default 1000 rows.",
		),
	filter: z
		.object({})
		.passthrough()
		.optional()
		.describe("Optional Query DSL filter applied before the ES|QL pipeline runs (e.g. a @timestamp range)."),
});

type EsqlQueryParams = z.infer<typeof esqlQueryValidator>;

function createEsqlQueryMcpError(
	error: Error | string,
	context: { type: "validation" | "execution"; details?: unknown },
): McpError {
	const message = error instanceof Error ? error.message : error;

	const errorCodeMap = {
		validation: ErrorCode.InvalidParams,
		execution: ErrorCode.InternalError,
	};

	return new McpError(errorCodeMap[context.type], `[elasticsearch_esql_query] ${message}`, context.details);
}

export const registerEsqlQueryTool: ToolRegistrationFunction = (server: McpServer, esClient: Client) => {
	const esqlQueryHandler = async (args: EsqlQueryParams): Promise<SearchResult> => {
		const perfStart = performance.now();

		try {
			const params = esqlQueryValidator.parse(args);

			const result = await esClient.esql.query(
				{
					query: params.query,
					...(params.filter && { filter: params.filter as Record<string, unknown> }),
				},
				{ opaqueId: "elasticsearch_esql_query" },
			);

			const duration = performance.now() - perfStart;
			if (duration > 5000) {
				logger.warn({ duration }, "Slow operation");
			}

			// SIO-1391: ES|QL returns column-oriented {columns:[{name,type}], values:[[...]]} (verified
			// live against eu-cld). Rows are emitted as objects keyed by column name so the model reads
			// a result without having to index positionally into a parallel array -- a shape LLMs
			// routinely mis-align. `columns` is kept so type info is not lost in the translation.
			const shaped = result as unknown as {
				columns?: Array<{ name?: string; type?: string }>;
				values?: unknown[][];
				is_partial?: boolean;
				took?: number;
			};
			const columns = shaped.columns ?? [];
			const rows = (shaped.values ?? []).map((row) =>
				Object.fromEntries(columns.map((col, i) => [col.name ?? `col_${i}`, row[i]])),
			);

			return {
				content: [
					{
						type: "text",
						text: JSON.stringify(
							{
								took: shaped.took,
								// ES|QL sets is_partial when some shards/clusters did not answer. Surfaced
								// explicitly: a partial result is not a valid basis for an absence claim.
								...(shaped.is_partial !== undefined && { is_partial: shaped.is_partial }),
								columns,
								row_count: rows.length,
								rows,
							},
							null,
							2,
						),
					},
				],
			};
		} catch (error) {
			if (error instanceof z.ZodError) {
				throw createEsqlQueryMcpError(`Validation failed: ${error.issues.map((e) => e.message).join(", ")}`, {
					type: "validation",
					details: { validationErrors: error.issues, providedArgs: args },
				});
			}

			// SIO-1391 (Layer 2, per SIO-1388): rethrow the RAW ES error so the central interceptor can
			// classify it structurally via `instanceof ResponseError`. Rebuilding an McpError here
			// would discard `meta.body.error`, and ES|QL's verification_exception needs the `reason`
			// text to tell "Unknown index" (not-found) from "Unknown column" (bad-query) -- verified
			// live: without this both arrive UNSTAMPED and count as degrading.
			throw error;
		}
	};

	server.registerTool(
		"elasticsearch_esql_query",
		{
			title: "Run ES|QL Query",
			description:
				"Run an ES|QL (Elasticsearch Query Language) pipeline query. Preferred over elasticsearch_search when you want filter + aggregate + sort in ONE call: 'FROM logs-* | WHERE log.level == \"error\" | STATS count = COUNT(*) BY service.name | SORT count DESC | LIMIT 10'. Read-only (ES|QL has no write commands). Returns rows as objects keyed by column name. Include a `| LIMIT <n>` clause -- enforced. Only an UNGROUPED `| STATS` (no `BY`) is exempt, since it returns one row; `STATS ... BY <field>` and `INLINESTATS` do NOT bound the rows and still require a LIMIT, else Elasticsearch returns 1000 rows. Use double quotes for string literals and == for equality. For plain document retrieval or highlighting, use elasticsearch_search instead.",
			inputSchema: esqlQueryValidator.shape,
		},
		esqlQueryHandler,
	);
};

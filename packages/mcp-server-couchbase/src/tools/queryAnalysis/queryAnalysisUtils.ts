/* src/tools/queryAnalysis/queryAnalysisUtils.ts */

import { buildToolErrorEnvelope } from "@devops-agent/shared";
import type { Bucket, QueryMetaData } from "couchbase";
import { adviseCouchbaseError } from "../../lib/adviseCouchbaseError";
import { classifyCouchbaseError } from "../../lib/classifyCouchbaseError";
import type { ToolResponse } from "../../types";
import { logger } from "../../utils/logger";

// SIO-1107: shared human-markdown renderer for both the cluster-context and
// scope-context executors. Extracted verbatim from executeAnalysisQuery so the
// response contract (title counts, Query Execution Details, SIO-664 Limit
// Application) stays byte-identical for existing tools.
function formatAnalysisResponse(
	rows: unknown[],
	meta: QueryMetaData | undefined,
	title?: string,
	requestedLimit?: number,
): ToolResponse {
	// Format the title with count information
	const titleWithCount = title
		? `${title} (${rows.length} result${rows.length !== 1 ? "s" : ""})`
		: `Query Results (${rows.length} result${rows.length !== 1 ? "s" : ""})`;

	// Format results for display
	let responseText = `# ${titleWithCount}\n\n`;

	if (rows.length === 0) {
		responseText += "No results found for this query.";
	} else {
		responseText += `\`\`\`json\n${JSON.stringify(rows, null, 2)}\n\`\`\``;
	}

	// Include query execution details if available
	if (meta) {
		responseText += "\n\n## Query Execution Details\n\n";
		responseText += `- **Status**: ${meta.status || "Completed"}\n`;
		if (meta.metrics) {
			responseText += `- **Elapsed Time**: ${meta.metrics?.elapsedTime || "N/A"}\n`;
			responseText += `- **Execution Time**: ${meta.metrics?.executionTime || "N/A"}\n`;
			responseText += `- **Result Count**: ${meta.metrics?.resultCount || rows.length}\n`;
			responseText += `- **Result Size**: ${meta.metrics?.resultSize || "N/A"} bytes\n`;
			responseText += `- **Mutation Count**: ${meta.metrics?.mutationCount ?? "N/A"}\n`;
		}
	}

	// SIO-664: honest applied-limit metadata. Without this, callers trusted the
	// requested limit even when the SQL++ predicate or upstream returned fewer rows.
	// Only emit when the LIMIT was actually applied -- the call sites guard with
	// `if (limit && limit > 0)` before splicing into SQL, so mirror that condition here.
	if (requestedLimit !== undefined && requestedLimit > 0) {
		const actualCount = rows.length;
		const effectiveLimit = Math.min(requestedLimit, actualCount);
		const capped = actualCount >= requestedLimit;
		responseText += "\n\n## Limit Application\n\n";
		responseText += `- **Requested Limit**: ${requestedLimit}\n`;
		responseText += `- **Actual Count**: ${actualCount}\n`;
		responseText += `- **Effective Limit**: ${effectiveLimit}\n`;
		responseText += `- **Capped**: ${capped}\n`;
	}

	return {
		content: [
			{
				type: "text",
				text: responseText,
			},
		],
	};
}

function formatAnalysisError(error: unknown): ToolResponse {
	// Full error (incl. stack) stays server-side; the client gets only the message.
	// Stack traces leak paths and waste sub-agent context (CodeRabbit, PR #378).
	logger.error({ error }, "Error executing analysis query");
	const message = error instanceof Error ? error.message : String(error);

	// SIO-1162: emit the shared { _error: { kind, category } } envelope like the other
	// query tools, instead of plain markdown. Plain markdown carried no kind, so every
	// queryAnalysis failure (e.g. capella_get_system_indexes) reached the agent as
	// category "unknown" = DEGRADING and capped confidence -- even a benign no-index. Now a
	// no-index planning failure classifies as no-data (non-degrading) and a real parse
	// failure as bad-query (degrading but actionable, with copy-paste advice). Only the
	// error branch changes; the success renderer (formatAnalysisResponse) is untouched, so
	// the resolve-identifiers probe's fenced-JSON contract still holds.
	const kind = classifyCouchbaseError(error);
	const advice = adviseCouchbaseError(kind);
	const envelope = buildToolErrorEnvelope({
		kind,
		message: `Error executing query: ${message}`,
		...(advice ? { advice } : {}),
	});

	return {
		content: [
			{
				type: "text",
				text: JSON.stringify(envelope),
			},
		],
		isError: true,
	};
}

/**
 * Execute a query and return formatted results
 *
 * @param bucket The Couchbase bucket to use
 * @param queryString The SQL++ query to execute
 * @param title Optional title for the response
 * @param requestedLimit Optional caller-supplied limit (SIO-664). When provided,
 *   the response includes a "Limit Application" section that exposes how many
 *   rows were actually returned vs requested -- so callers don't trust an
 *   echoed value when the SQL++ predicate filtered more than expected.
 * @param parameters Optional named-parameter bag (SIO-667). When provided and
 *   non-empty, forwarded to `cluster.query(stmt, { parameters })` so user-supplied
 *   values bind as N1QL literals instead of being string-interpolated. Closes
 *   the SQL++ injection class on filter-only queryAnalysis tools.
 */
export async function executeAnalysisQuery(
	bucket: Bucket,
	queryString: string,
	title?: string,
	requestedLimit?: number,
	parameters?: Record<string, unknown>,
): Promise<ToolResponse> {
	try {
		logger.info(`Executing analysis query: ${title || "Unnamed query"}`);

		const hasParameters = parameters !== undefined && Object.keys(parameters).length > 0;
		if (hasParameters) {
			// Log keys only -- values may be user-controlled.
			logger.debug({ paramKeys: Object.keys(parameters as Record<string, unknown>) }, "Query bound parameters");
		}

		const cluster = bucket.cluster;
		const result = hasParameters ? await cluster.query(queryString, { parameters }) : await cluster.query(queryString);
		const rows = await result.rows;
		return formatAnalysisResponse(rows, result.meta, title, requestedLimit);
	} catch (error) {
		return formatAnalysisError(error);
	}
}

/**
 * SIO-1107: scope-context sibling of executeAnalysisQuery. Statements like
 * `SELECT ADVISOR(...)` over bare collection names must plan inside a scope
 * (`bucket.scope(name).query`), which cluster-context execution cannot do.
 * Identical formatting and error contract to executeAnalysisQuery.
 */
export async function executeScopedAnalysisQuery(
	bucket: Bucket,
	scopeName: string,
	queryString: string,
	title?: string,
	requestedLimit?: number,
	parameters?: Record<string, unknown>,
): Promise<ToolResponse> {
	try {
		logger.info(`Executing scoped analysis query: ${title || "Unnamed query"} (scope: ${scopeName})`);

		const hasParameters = parameters !== undefined && Object.keys(parameters).length > 0;
		if (hasParameters) {
			// Log keys only -- values may be user-controlled.
			logger.debug({ paramKeys: Object.keys(parameters as Record<string, unknown>) }, "Query bound parameters");
		}

		const scope = bucket.scope(scopeName);
		const result = hasParameters ? await scope.query(queryString, { parameters }) : await scope.query(queryString);
		const rows = await result.rows;
		return formatAnalysisResponse(rows, result.meta, title, requestedLimit);
	} catch (error) {
		return formatAnalysisError(error);
	}
}

/**
 * SIO-772: machine-readable sibling of executeAnalysisQuery for tools whose
 * output feeds correlation extractors. Returns ToolResponse with a bare-JSON
 * text payload (no markdown rendering, no Limit Application section). The
 * agent's tryParseJson(String(m.content)) parses it into ToolOutput.rawJson
 * as the raw rows array.
 *
 * On cluster errors, returns { content: [{...}], isError: true } with a
 * JSON-shaped error payload -- matches the sibling executeAnalysisQuery's
 * MCP error contract so the agent surfaces it as a toolError rather than
 * a thrown JSON-RPC error. Use this instead of executeAnalysisQuery when
 * the consumer is structural (extractFindings node, sub-agent reasoning)
 * rather than human (CLI render).
 */
export async function executeAnalysisQueryStructured(
	bucket: Bucket,
	queryString: string,
	parameters?: Record<string, unknown>,
): Promise<ToolResponse> {
	try {
		const hasParameters = parameters !== undefined && Object.keys(parameters).length > 0;
		const cluster = bucket.cluster;
		const result = hasParameters ? await cluster.query(queryString, { parameters }) : await cluster.query(queryString);
		const rows = await result.rows;
		return { content: [{ type: "text", text: JSON.stringify(rows) }] };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		logger.error(`Error executing structured analysis query: ${message}`);
		// SIO-1162: emit the shared { _error } envelope here too (previously { error: message },
		// an unstructured shape that the agent read as category "unknown" = degrading). A
		// no-index failure here now classifies as no-data (non-degrading).
		const kind = classifyCouchbaseError(error);
		const advice = adviseCouchbaseError(kind);
		const envelope = buildToolErrorEnvelope({
			kind,
			message: `Error executing query: ${message}`,
			...(advice ? { advice } : {}),
		});
		return {
			content: [{ type: "text", text: JSON.stringify(envelope) }],
			isError: true,
		};
	}
}

/* src/tools/queryAnalysis/queryAnalysisUtils.ts */

import type { Bucket } from "couchbase";
import type { ToolResponse } from "../../types";
import { logger } from "../../utils/logger";

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
 * @returns Formatted tool response with query results
 */
export async function executeAnalysisQuery(
	bucket: Bucket,
	queryString: string,
	title?: string,
	requestedLimit?: number,
): Promise<ToolResponse> {
	try {
		logger.info(`Executing analysis query: ${title || "Unnamed query"}`);

		// Execute the query
		const cluster = bucket.cluster;
		const result = await cluster.query(queryString);
		const rows = await result.rows;

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
		if (result.meta) {
			responseText += "\n\n## Query Execution Details\n\n";
			responseText += `- **Status**: ${result.meta.status || "Completed"}\n`;
			if (result.meta.metrics) {
				responseText += `- **Elapsed Time**: ${result.meta.metrics?.elapsedTime || "N/A"}\n`;
				responseText += `- **Execution Time**: ${result.meta.metrics?.executionTime || "N/A"}\n`;
				responseText += `- **Result Count**: ${result.meta.metrics?.resultCount || rows.length}\n`;
				responseText += `- **Result Size**: ${result.meta.metrics?.resultSize || "N/A"} bytes\n`;
				responseText += `- **Mutation Count**: ${result.meta.metrics?.mutationCount ?? "N/A"}\n`;
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
	} catch (error) {
		logger.error(`Error executing analysis query: ${error instanceof Error ? error.message : String(error)}`);

		return {
			content: [
				{
					type: "text",
					text: `## Error Executing Query\n\n${error instanceof Error ? error.stack || error.message : typeof error === "object" ? JSON.stringify(error, null, 2) : String(error)}`,
				},
			],
			isError: true,
		};
	}
}

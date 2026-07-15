// src/tools/queryAnalysis/getIndexAdvisor.ts

import { buildToolErrorEnvelope } from "@devops-agent/shared";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Bucket } from "couchbase";
import { z } from "zod";
import { classifyCouchbaseError } from "../../lib/classifyCouchbaseError";
import { resolveBucket } from "../../lib/resolveBucket";
import { logger } from "../../utils/logger";
import { n1qlIndexAdvisor } from "./analysisQueries";

export type IndexAdvisorInput = {
	query: string;
};

// The analyzed statement binds as $advise_statement -- injection-closed by
// construction (SIO-667 posture; mirrors the official Python server).
export function buildQuery(input: IndexAdvisorInput): {
	query: string;
	parameters: Record<string, unknown>;
} {
	return { query: n1qlIndexAdvisor, parameters: { advise_statement: input.query } };
}

export interface AdvisorSections {
	current: string[];
	recommended: string[];
	covering: string[];
}

// ADVISOR() output shape varies across server versions (adviseinfo nesting,
// current_indexes vs current_used_indexes; recommended entries carry
// `index_statement` while current entries carry `index` -- both hold DDL,
// validated against the live Capella cluster). Walk the whole result and
// classify every DDL string by the nearest meaningful ancestor key instead of
// hardcoding one shape.
export function extractAdvisorSections(result: unknown): AdvisorSections {
	const sections: AdvisorSections = { current: [], recommended: [], covering: [] };
	const push = (list: string[], value: string) => {
		if (!list.includes(value)) list.push(value);
	};
	const walk = (node: unknown, path: string[]): void => {
		if (node === null || typeof node !== "object") return;
		if (Array.isArray(node)) {
			for (const item of node) walk(item, path);
			return;
		}
		for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
			// The CREATE guard keeps non-DDL `index` fields (e.g. an index NAME) out.
			const isDdl =
				typeof value === "string" &&
				(key === "index_statement" || (key === "index" && /^CREATE\s/i.test(value.trim())));
			if (isDdl && typeof value === "string") {
				if (path.some((p) => /covering/i.test(p))) push(sections.covering, value);
				else if (path.some((p) => /current/i.test(p))) push(sections.current, value);
				else push(sections.recommended, value);
				continue;
			}
			walk(value, [...path, key]);
		}
	};
	walk(result, []);
	return sections;
}

export function formatAdvisorResult(analyzedQuery: string, rows: unknown[]): string {
	const sections = extractAdvisorSections(rows);
	const total = sections.recommended.length + sections.covering.length;

	let text = "# Index Advisor Recommendations\n\n";
	text += `## Analyzed Statement\n\n\`\`\`sql\n${analyzedQuery}\n\`\`\`\n\n`;
	text += "## Summary\n\n";
	text += `- Current indexes used: ${sections.current.length}\n`;
	text += `- Recommended indexes: ${sections.recommended.length}\n`;
	text += `- Recommended covering indexes: ${sections.covering.length}\n`;
	text += `- Has recommendations: ${total > 0}\n\n`;

	const renderList = (title: string, statements: string[]) => {
		if (statements.length === 0) return "";
		return `## ${title}\n\n${statements.map((s) => `\`\`\`sql\n${s}\n\`\`\``).join("\n\n")}\n\n`;
	};
	text += renderList("Current Indexes Used", sections.current);
	text += renderList("Recommended Indexes", sections.recommended);
	text += renderList("Recommended Covering Indexes", sections.covering);

	if (total === 0) {
		text += "The advisor returned no index recommendations -- the query may already be served by existing indexes.\n\n";
	}
	text += `## Raw Advisor Output\n\n\`\`\`json\n${JSON.stringify(rows, null, 2)}\n\`\`\`\n`;
	return text;
}

// Exported for unit testing.
export const adviseQuery = async (
	params: { scope_name: string; query: string; bucket_name?: string },
	bucket: Bucket,
) => {
	const { scope_name, query, bucket_name } = params;
	const { query: statement, parameters } = buildQuery({ query });
	try {
		// Scope context so bare collection names in the analyzed statement resolve.
		const resolved = resolveBucket(bucket, bucket_name);
		const result = await resolved.scope(scope_name).query(statement, { parameters });
		const rows = await result.rows;
		return { content: [{ type: "text" as const, text: formatAdvisorResult(query, rows) }] };
	} catch (error) {
		logger.error({ error }, "Index advisor query failed");
		const message = error instanceof Error ? error.message : String(error);
		const kind = classifyCouchbaseError(error);
		const envelope = buildToolErrorEnvelope({ kind, message: `Index advisor failed: ${message}` });
		return {
			content: [{ type: "text" as const, text: JSON.stringify(envelope) }],
			isError: true,
		};
	}
};

export default (server: McpServer, bucket: Bucket) => {
	server.tool(
		"capella_get_index_advisor_recommendations",
		"Run the server-computed Couchbase Index Advisor (SELECT ADVISOR) on a SQL++ query and return current, recommended, and covering index DDL. Evaluates only -- never creates indexes.",
		{
			scope_name: z.string().describe("Name of the scope to analyze the query in"),
			query: z
				.string()
				.describe("SQL++ query to analyze. Use only the collection name in the FROM clause (scope context)."),
			bucket_name: z.string().optional().describe("Optional bucket name (defaults to the configured bucket)"),
		},
		async (params) => {
			logger.info({ scope: params.scope_name, bucket: params.bucket_name }, "Running index advisor");
			return adviseQuery(params, bucket);
		},
	);
};

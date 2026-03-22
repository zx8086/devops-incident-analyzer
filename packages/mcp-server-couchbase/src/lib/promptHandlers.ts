/* src/lib/promptHandlers.ts */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { logger } from "./logger";

export function registerPrompts(server: McpServer): void {
	server.tool(
		"generate_query",
		"Generate a SQL++ query based on description",
		{
			description: z.string().describe("Description of the data you want to query"),
			bucketName: z.string().describe("Bucket name"),
			scopeName: z.string().describe("Scope name"),
			collectionName: z.string().describe("Collection name"),
		},
		({ description, bucketName, scopeName, collectionName }) => ({
			content: [
				{
					type: "text",
					text: `Please generate a SQL++ query for the Couchbase bucket "${bucketName}", scope "${scopeName}", and collection "${collectionName}" that will ${description}.

Remember to:
1. Use backticks around bucket, scope, and collection names
2. Use the fully qualified path: \`${bucketName}\`.\`${scopeName}\`.\`${collectionName}\`
3. Ensure the query is syntactically correct and optimized
4. Limit results to a reasonable amount (e.g., LIMIT 10) unless otherwise specified`,
				},
			],
		}),
	);

	server.tool(
		"analyze_schema",
		"Analyze a document schema",
		{
			schemaJson: z.string().describe("JSON schema to analyze"),
			purpose: z.string().optional().describe("Purpose of the analysis"),
		},
		({ schemaJson, purpose }) => {
			const purposeText = purpose ? `\nFocus on aspects relevant to: ${purpose}` : "";

			return {
				content: [
					{
						type: "text",
						text: `Please analyze this Couchbase document schema and provide insights:${purposeText}

\`\`\`json
${schemaJson}
\`\`\`

Include in your analysis:
1. The overall structure and its suitability for a NoSQL database
2. Any potential index recommendations
3. Data type consistency
4. Opportunities for optimization
5. Potential query patterns that would work well with this schema`,
					},
				],
			};
		},
	);

	server.tool(
		"validate_document",
		"Validate a document against best practices",
		{
			document: z.string().describe("JSON document to validate"),
			validationRules: z.string().optional().describe("Additional validation rules"),
		},
		({ document, validationRules }) => {
			const rulesText = validationRules ? `\nApply these additional validation rules:\n${validationRules}` : "";

			return {
				content: [
					{
						type: "text",
						text: `Please validate this Couchbase document for best practices and provide feedback:${rulesText}

\`\`\`json
${document}
\`\`\`

In your validation:
1. Check for proper JSON structure and formatting
2. Verify data types are consistent and appropriate
3. Identify any missing required fields
4. Suggest improvements for NoSQL optimization
5. Flag any potential issues with field naming, nesting, or data representation`,
					},
				],
			};
		},
	);

	// Index advisor tool
	server.tool(
		"advise_indexes",
		"Suggest optimal indexes for a query",
		{
			query: z.string().describe("SQL++ query to analyze"),
			schemaInfo: z.string().optional().describe("Collection schema information"),
		},
		({ query, schemaInfo }) => {
			const schemaText = schemaInfo
				? `\nThe collection has the following schema:\n\`\`\`\n${schemaInfo}\n\`\`\`\n`
				: "";

			return {
				content: [
					{
						type: "text",
						text: `Please analyze this SQL++ query and recommend appropriate indexes:${schemaText}

\`\`\`sql
${query}
\`\`\`

In your recommendation:
1. Identify fields that should be indexed based on WHERE clauses, JOIN conditions, and ORDER BY statements
2. Suggest specific CREATE INDEX statements for Couchbase
3. Consider covering indexes where appropriate
4. Explain the reasoning behind each recommended index
5. Note any potential performance implications`,
					},
				],
			};
		},
	);

	logger.info("Prompt handlers registered successfully");
}

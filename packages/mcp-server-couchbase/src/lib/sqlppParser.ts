/* src/lib/sqlppParser.ts */

import type { ASTNode, SQLPPParser } from "../types";
import { logger } from "../utils/logger";

export class SQLPPParserImpl implements SQLPPParser {
	private readonly dataModificationKeywords = new Set(["INSERT", "UPDATE", "DELETE", "UPSERT", "MERGE"]);

	private readonly structureModificationKeywords = new Set(["CREATE", "DROP", "ALTER", "GRANT", "REVOKE"]);

	private readonly queryKeywords = new Set([
		"SELECT",
		"FROM",
		"WHERE",
		"GROUP BY",
		"HAVING",
		"ORDER BY",
		"LIMIT",
		"OFFSET",
		"JOIN",
		"LEFT JOIN",
		"RIGHT JOIN",
		"INNER JOIN",
		"UNION",
		"INTERSECT",
		"EXCEPT",
	]);

	parse(query: string): ASTNode {
		const cleanedQuery = this.removeComments(query);
		logger.debug({ queryLength: query.length }, "Parsing SQL++ query");

		const tokens = this.tokenize(cleanedQuery);
		const ast = this.buildAST(tokens);

		logger.debug(
			{
				queryType: ast.type,
				hasWhere: ast.hasWhere,
				hasLimit: ast.hasLimit,
			},
			"Query parsed successfully",
		);

		return ast;
	}

	modifiesData(parsedQuery: ASTNode): boolean {
		if (!parsedQuery.rawQuery) return false;

		const query = parsedQuery.rawQuery.toUpperCase();
		const firstToken = this.tokenize(query)[0];

		// Check if the first token is a data modification keyword
		const result = firstToken !== undefined && this.dataModificationKeywords.has(firstToken);

		if (result) {
			logger.debug(
				{
					operation: firstToken,
				},
				"Query identified as data modification query",
			);
		}

		return result;
	}

	modifiesStructure(parsedQuery: ASTNode): boolean {
		if (!parsedQuery.rawQuery) return false;

		const query = parsedQuery.rawQuery.toUpperCase();
		const firstToken = this.tokenize(query)[0];

		// Check if the first token is a structure modification keyword
		const result = firstToken !== undefined && this.structureModificationKeywords.has(firstToken);

		if (result) {
			logger.debug(
				{
					operation: firstToken,
				},
				"Query identified as structure modification query",
			);
		}

		return result;
	}

	private tokenize(query: string): string[] {
		// Split on whitespace but preserve quoted strings
		const tokens: string[] = [];
		let currentToken = "";
		let inQuotes = false;
		let quoteChar = "";

		for (let i = 0; i < query.length; i++) {
			const char = query[i];

			if ((char === '"' || char === "'" || char === "`") && (i === 0 || query[i - 1] !== "\\")) {
				if (!inQuotes) {
					inQuotes = true;
					quoteChar = char;
				} else if (char === quoteChar) {
					inQuotes = false;
				}
			}

			if (char === " " && !inQuotes) {
				if (currentToken) {
					tokens.push(currentToken);
					currentToken = "";
				}
			} else {
				currentToken += char;
			}
		}

		if (currentToken) {
			tokens.push(currentToken);
		}

		return tokens;
	}

	private buildAST(tokens: string[]): ASTNode {
		const ast: ASTNode = {
			type: "ROOT",
			rawQuery: tokens.join(" "),
			hasWhere: false,
			hasLimit: false,
			children: [],
		};

		let currentClause = "";
		let currentClauseTokens: string[] = [];

		for (let i = 0; i < tokens.length; i++) {
			const rawToken = tokens[i];
			if (rawToken === undefined) continue;
			const token = rawToken.toUpperCase();

			if (this.queryKeywords.has(token)) {
				if (currentClause && currentClauseTokens.length > 0) {
					ast.children?.push({
						type: currentClause,
						value: currentClauseTokens.join(" "),
					});
					currentClauseTokens = [];
				}
				currentClause = token;
			} else {
				currentClauseTokens.push(rawToken);
			}

			if (token === "WHERE") ast.hasWhere = true;
			if (token === "LIMIT") ast.hasLimit = true;
		}

		if (currentClause && currentClauseTokens.length > 0) {
			ast.children?.push({
				type: currentClause,
				value: currentClauseTokens.join(" "),
			});
		}

		return ast;
	}

	private removeComments(query: string): string {
		let cleaned = query.replace(/--.*$/gm, ""); // Remove single-line comments
		cleaned = cleaned.replace(/\/\*[\s\S]*?\*\//g, ""); // Remove multi-line comments
		return cleaned.trim();
	}
}

export const sqlppParser = new SQLPPParserImpl();

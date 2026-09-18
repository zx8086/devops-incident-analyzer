/* src/lib/sqlppParser.ts */

import type { ASTNode, SQLPPParser } from "../types";
import { logger } from "../utils/logger";

export class SQLPPParserImpl implements SQLPPParser {
	// SIO-1813: PREPARE and EXECUTE are refused wholesale. EXECUTE runs a server-side
	// prepared statement or a UDF this gate cannot inspect, and PREPARE has no use without it.
	private readonly dataModificationKeywords = new Set([
		"INSERT",
		"UPDATE",
		"DELETE",
		"UPSERT",
		"MERGE",
		"PREPARE",
		"EXECUTE",
	]);

	// SIO-1813: ANALYZE is the synonym of UPDATE STATISTICS, which UPDATE already refuses.
	private readonly structureModificationKeywords = new Set([
		"CREATE",
		"DROP",
		"ALTER",
		"GRANT",
		"REVOKE",
		"BUILD",
		"ANALYZE",
	]);

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
		const operation = this.statementHeads(parsedQuery).find((head) => this.dataModificationKeywords.has(head));

		if (operation) {
			logger.debug({ operation }, "Query identified as data modification query");
		}

		return operation !== undefined;
	}

	modifiesStructure(parsedQuery: ASTNode): boolean {
		const operation = this.statementHeads(parsedQuery).find((head) => this.structureModificationKeywords.has(head));

		if (operation) {
			logger.debug({ operation }, "Query identified as structure modification query");
		}

		return operation !== undefined;
	}

	// SIO-1813: this is the read-only boundary for the server, so it must read a statement's
	// leading keyword the way the query service does. One head per ";"-separated statement,
	// past any opening parentheses, cut at the first non-letter ("UPDATE`c`" is UPDATE).
	//
	// Deliberately NOT refused:
	// - EXPLAIN / ADVISE <mutation>: they plan the statement and never run it (SIO-1107).
	// - BEGIN / START / COMMIT / ROLLBACK / SAVEPOINT / SET: they mutate nothing themselves,
	//   and every DML inside a transaction is its own request through this gate.
	//
	// Fails closed on quoting: whether a backslash escapes the closing quote of a string is
	// read BOTH ways, and a mutation head under either reading refuses. A reading that keeps
	// the tokenizer inside a quote the server has closed would hide a following "; DELETE".
	private statementHeads(parsedQuery: ASTNode): string[] {
		if (!parsedQuery.rawQuery) return [];

		const query = parsedQuery.rawQuery.toUpperCase();
		const heads: string[] = [];

		for (const backslashEscapes of [true, false]) {
			let atStatementStart = true;

			for (const token of this.tokenize(query, backslashEscapes)) {
				if (token === ";") {
					atStatementStart = true;
					continue;
				}
				if (!atStatementStart) continue;

				const unwrapped = token.replace(/^\(+/, "");
				if (!unwrapped) continue;

				heads.push(unwrapped.match(/^[A-Z_]+/)?.[0] ?? "");
				atStatementStart = false;
			}
		}

		return heads;
	}

	private tokenize(query: string, backslashEscapes = true): string[] {
		// Split on any whitespace, and emit ";" as its own token, but preserve quoted strings
		const tokens: string[] = [];
		let currentToken = "";
		let inQuotes = false;
		let quoteChar = "";

		for (let i = 0; i < query.length; i++) {
			const char = query.charAt(i);

			// SIO-1813: inside a string a backslash consumes the next character, so "\\\\" is a
			// pair and the quote after it still closes. Backtick identifiers have no backslash
			// escape (a backtick is escaped by doubling, which the toggle below already handles).
			if (backslashEscapes && inQuotes && quoteChar !== "`" && char === "\\") {
				currentToken += char + query.charAt(i + 1);
				i++;
				continue;
			}

			if (char === '"' || char === "'" || char === "`") {
				if (!inQuotes) {
					inQuotes = true;
					quoteChar = char;
				} else if (char === quoteChar) {
					inQuotes = false;
				}
			}

			if (!inQuotes && (char === ";" || /\s/.test(char))) {
				if (currentToken) {
					tokens.push(currentToken);
					currentToken = "";
				}
				if (char === ";") tokens.push(";");
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
		// SIO-1813: a comment separates tokens, so it becomes a space. Replacing it with ""
		// glued "DELETE/**/FROM" into "DELETEFROM", which the gate did not recognise.
		let cleaned = query.replace(/--.*$/gm, " ");
		cleaned = cleaned.replace(/\/\*[\s\S]*?\*\//g, " ");
		return cleaned.trim();
	}
}

export const sqlppParser = new SQLPPParserImpl();

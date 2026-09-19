/* src/lib/sqlppParser.ts */

import type { ASTNode, SQLPPParser } from "../types";
import { logger } from "../utils/logger";

export class SQLPPParserImpl implements SQLPPParser {
	// SIO-1822: the read-only decision is an ALLOW-LIST -- a statement head that is not
	// provably a read is refused. The previous deny-list let any unlisted statement class
	// through, which was not theoretical: FLUSH COLLECTION and TRUNCATE COLLECTION both
	// empty a collection and both passed the gate because neither keyword was listed.
	//
	// The heads below are derived from the query service grammar (couchbase/query
	// parser/n1ql/n1ql.y, rule `stmt_body`), not from memory. Read paths there are
	// advise | explain | prepare | execute | explain_function | select_stmt | infer;
	// every other class under `stmt` writes. Resolving each class to its leading terminal
	// gives exactly this set, with one overlap handled below.
	//
	// FROM is here because `subselect: from_select | select_from` means a plain SELECT may
	// legitimately begin with FROM ("FROM k SELECT x"); refusing it would break valid reads.
	// A parenthesised fullselect needs no entry -- statementHeads() already strips leading
	// "(", so "(SELECT 1)" arrives here as SELECT.
	//
	// The transaction/session heads keep the SIO-1813 ruling: BEGIN/START/COMMIT/ROLLBACK/
	// SAVEPOINT/SET mutate no data themselves, and every DML inside a transaction arrives as
	// its own request through this same gate. They are allowed here for that reason, not
	// because they are reads -- flipping them would be a behaviour change beyond SIO-1822.
	private readonly readOnlyStatementHeads = new Set([
		"SELECT",
		"FROM",
		"WITH",
		"INFER",
		"EXPLAIN",
		"ADVISE",
		"BEGIN",
		"START",
		"COMMIT",
		"ROLLBACK",
		"SAVEPOINT",
		"SET",
	]);

	// SIO-1813: PREPARE and EXECUTE stay refused. They are the one place the grammar's read
	// set and write set overlap (`execute` is a read path, `function_stmt` has EXECUTE
	// FUNCTION), and both run server-side statements this gate cannot inspect -- so they are
	// deliberately absent from the allow-list above rather than resolved by the head alone.
	//
	// The two sets below no longer decide anything; they only LABEL a refusal as data vs
	// structure for the error message. A head in neither set is still refused, by the
	// allow-list, and labelled as a generic write.
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
		// SIO-1822: grammar ddl_stmt/collection_stmt. Both empty a collection and both
		// passed the old deny-list gate.
		"FLUSH",
		"TRUNCATE",
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

	// SIO-1822: the refused heads, i.e. every statement head this query does NOT prove to be
	// a read. One traversal, so modifiesData/modifiesStructure cannot disagree about which
	// heads are writes -- they only split the same refusals into two labels.
	private writeStatementHeads(parsedQuery: ASTNode): string[] {
		return this.statementHeads(parsedQuery).filter((head) => !this.readOnlyStatementHeads.has(head));
	}

	modifiesData(parsedQuery: ASTNode): boolean {
		const heads = this.writeStatementHeads(parsedQuery);
		// A refused head that is not a known DDL keyword is reported here, so an unrecognised
		// statement class is refused by SOME call site rather than falling between the two.
		const operation = heads.find((head) => !this.structureModificationKeywords.has(head));

		if (operation) {
			logger.debug(
				{ operation, known: this.dataModificationKeywords.has(operation) },
				"Query identified as data modification query",
			);
		}

		return operation !== undefined;
	}

	modifiesStructure(parsedQuery: ASTNode): boolean {
		const operation = this.writeStatementHeads(parsedQuery).find((head) =>
			this.structureModificationKeywords.has(head),
		);

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
	// The heads after the first are defense in depth: the query service grammar is
	// `input: stmt_body opt_trailer` with opt_trailer being only ";" (couchbase/query
	// parser/n1ql/n1ql.y), so a request carrying a second statement is a syntax error there.
	private statementHeads(parsedQuery: ASTNode): string[] {
		if (!parsedQuery.rawQuery) return [];

		const heads: string[] = [];
		let atStatementStart = true;

		for (const token of this.tokenize(parsedQuery.rawQuery.toUpperCase())) {
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

		return heads;
	}

	private tokenize(query: string): string[] {
		// Split on any whitespace, and emit ";" as its own token, but preserve quoted strings
		const tokens: string[] = [];
		let currentToken = "";
		let inQuotes = false;
		let quoteChar = "";

		for (let i = 0; i < query.length; i++) {
			const char = query.charAt(i);

			// SIO-1813: quoting follows the query service lexer (couchbase/query parser/n1ql/n1ql.nex),
			// which has one rule for "...", '...' and `...` alike: a backslash consumes the next
			// character. So "\\\\" is a pair and the quote after it still closes, while \' and \`
			// do not close. A doubled quote is the other escape, and the toggle below handles it.
			if (inQuotes && char === "\\") {
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

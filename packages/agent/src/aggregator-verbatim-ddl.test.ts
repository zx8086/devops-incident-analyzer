// packages/agent/src/aggregator-verbatim-ddl.test.ts
import { describe, expect, test } from "bun:test";
import { type DataSourceResult, redactPiiContent } from "@devops-agent/shared";
import { ensureVerbatimDdl, extractCreateIndexStatements } from "./aggregator.ts";

const DDL_VARIANT = `CREATE INDEX adv_variant_fmsSeasonCode
ON \`default\`:\`default\`.\`styles\`.\`variant\`
(\`fmsSeasonCode\`, \`articleType\`)`;

const DDL_ARTICLE = `CREATE INDEX adv_article_salesStatusCodes_covering
ON \`default\`:\`default\`.\`styles\`.\`article\`(\`salesStatusCodes\`.\`INCK\`, \`articleNo\`)`;

const COUCHBASE_PROSE = `## Query optimization

EXPLAIN shows IndexScan3 followed by Fetch (non-covering).

\`\`\`sql
${DDL_VARIANT}
\`\`\`

\`\`\`sql
${DDL_ARTICLE}
\`\`\`

Report the DDL as a recommendation only.`;

function result(over: Partial<DataSourceResult>): DataSourceResult {
	return { dataSourceId: "couchbase", data: {}, status: "success", ...over };
}

describe("extractCreateIndexStatements (SIO-1140)", () => {
	test("pulls every fenced CREATE INDEX statement from sub-agent prose", () => {
		const { statements } = extractCreateIndexStatements([result({ data: COUCHBASE_PROSE })]);
		expect(statements).toHaveLength(2);
		expect(statements[0]).toContain("adv_variant_fmsSeasonCode");
		expect(statements[1]).toContain("adv_article_salesStatusCodes_covering");
	});

	test("dedups identical statements across results by normalized whitespace", () => {
		const reflowed = DDL_VARIANT.replace(/\n/g, " ");
		const { statements } = extractCreateIndexStatements([
			result({ data: `\`\`\`sql\n${DDL_VARIANT}\n\`\`\`` }),
			result({ data: `Advisor said: ${reflowed}\n\nDone.` }),
		]);
		expect(statements).toHaveLength(1);
	});

	test("ignores prose mentions of CREATE INDEX without the ON <keyspace>(<keys>) shape", () => {
		const { statements } = extractCreateIndexStatements([
			result({ data: "You should CREATE INDEX statements per the advisor.\n\nNext steps follow." }),
		]);
		expect(statements).toHaveLength(0);
	});

	test("ignores non-string result data", () => {
		expect(extractCreateIndexStatements([result({ data: {} })]).statements).toHaveLength(0);
	});

	test("preserves a terminating semicolon and dedups against the unterminated form", () => {
		const { statements } = extractCreateIndexStatements([
			result({ data: "```sql\nCREATE INDEX idx_orders_status ON orders(status);\n```" }),
			result({ data: "```sql\nCREATE INDEX idx_orders_status ON orders(status)\n```" }),
		]);
		expect(statements).toHaveLength(1);
		expect(statements[0]).toBe("CREATE INDEX idx_orders_status ON orders(status);");
	});

	test("rejects prose that mimics the DDL shape without a key list", () => {
		const { statements } = extractCreateIndexStatements([
			result({ data: "CREATE INDEX guidance ON staging (not production) before the next release.\n\nMore prose." }),
		]);
		expect(statements).toHaveLength(0);
	});

	test("passes extracted DDL through the injected redactor (deterministic, order-independent)", () => {
		// Sibling aggregator suites mock.module @devops-agent/shared with an identity
		// redactor and this package runs unisolated, so asserting the real redactor's
		// concrete output is file-order-dependent. Injecting a non-identity redactor
		// makes a dropped redact call fail deterministically in any run order.
		const raw = 'CREATE INDEX adv_owner ON users(`ownerEmail`) WHERE ownerEmail = "jane.doe@example.com";';
		const { statements } = extractCreateIndexStatements([result({ data: `\`\`\`sql\n${raw}\n\`\`\`` })], (s) =>
			s.replaceAll("jane.doe@example.com", "[EMAIL_REDACTED]"),
		);
		expect(statements).toHaveLength(1);
		expect(statements[0]).toContain("[EMAIL_REDACTED]");
		expect(statements[0]).not.toContain("jane.doe@example.com");
	});

	test("defaults to the live redactPiiContent binding when no redactor is injected", () => {
		const raw = 'CREATE INDEX adv_owner ON users(`ownerEmail`) WHERE ownerEmail = "jane.doe@example.com";';
		const { statements } = extractCreateIndexStatements([result({ data: `\`\`\`sql\n${raw}\n\`\`\`` })]);
		expect(statements).toHaveLength(1);
		expect(statements[0]).toBe(redactPiiContent(raw));
	});
});

describe("ensureVerbatimDdl (SIO-1140)", () => {
	const answerWithoutDdl = `# Incident Report

Recommendation: add a composite covering index on styles.variant covering fmsSeasonCode and articleType.

## Gaps

- none

Confidence: 0.74`;

	test("appends dropped DDL verbatim above the Confidence line", () => {
		const { answer, appended } = ensureVerbatimDdl(answerWithoutDdl, [result({ data: COUCHBASE_PROSE })]);
		expect(appended).toHaveLength(2);
		expect(answer).toContain("## Server-computed index DDL (verbatim)");
		expect(answer).toContain(DDL_VARIANT);
		expect(answer).toContain(DDL_ARTICLE);
		// SIO-632 contract: the dedicated Confidence line remains last.
		const lines = answer.trimEnd().split("\n");
		expect(lines[lines.length - 1]).toBe("Confidence: 0.74");
		expect(answer.indexOf("Server-computed index DDL")).toBeLessThan(answer.indexOf("Confidence: 0.74"));
	});

	test("no-op when the answer already carries the DDL, even reflowed", () => {
		const reflowedAnswer = `Report body.\n\n${DDL_VARIANT.replace(/\n/g, " ")}\n\n${DDL_ARTICLE}\n\nConfidence: 0.8`;
		const { answer, appended } = ensureVerbatimDdl(reflowedAnswer, [result({ data: COUCHBASE_PROSE })]);
		expect(appended).toHaveLength(0);
		expect(answer).toBe(reflowedAnswer);
	});

	test("appends only the statements the answer is missing", () => {
		const partial = `Report body.\n\n\`\`\`sql\n${DDL_VARIANT}\n\`\`\`\n\nConfidence: 0.8`;
		const { answer, appended } = ensureVerbatimDdl(partial, [result({ data: COUCHBASE_PROSE })]);
		expect(appended).toHaveLength(1);
		expect(appended[0]).toContain("adv_article_salesStatusCodes_covering");
		// The already-present statement is not duplicated.
		expect(answer.split("adv_variant_fmsSeasonCode")).toHaveLength(2);
	});

	test("no-op when no result carries DDL", () => {
		const { answer, appended } = ensureVerbatimDdl(answerWithoutDdl, [result({ data: "healthy cluster" })]);
		expect(appended).toHaveLength(0);
		expect(answer).toBe(answerWithoutDdl);
	});

	test("semicolon-only difference between prose and answer does not trigger an append", () => {
		const proseWithSemicolon = "```sql\nCREATE INDEX idx_orders_status ON orders(status);\n```";
		const answerWithoutSemicolon = "Body.\n\nCREATE INDEX idx_orders_status ON orders(status)\n\nConfidence: 0.8";
		const { answer, appended } = ensureVerbatimDdl(answerWithoutSemicolon, [result({ data: proseWithSemicolon })]);
		expect(appended).toHaveLength(0);
		expect(answer).toBe(answerWithoutSemicolon);
	});

	test("appends at the end when the answer has no Confidence line", () => {
		const { answer, appended } = ensureVerbatimDdl("Report body only.", [result({ data: COUCHBASE_PROSE })]);
		expect(appended).toHaveLength(2);
		expect(answer.endsWith("```\n")).toBe(true);
		expect(answer.startsWith("Report body only.")).toBe(true);
	});
});

// SIO-1149: advisor provenance. The localcore run's prose contained the EXISTING
// ARTICLE_variantNo index DDL (reconstructed from capella_get_detailed_indexes rows);
// the appender rescued it and mislabeled it as an Index Advisor recommendation while
// the real covering-index recommendation was already in the answer body. When the
// capella_get_index_advisor_recommendations toolOutput is present, only its
// Recommended sections are DDL candidates.
const DDL_EXISTING = "CREATE INDEX ARTICLE_variantNo ON `default`:`default`.`styles`.`article`(`variantNo`)";

const ADVISOR_MARKDOWN = `# Index Advisor Recommendations

## Analyzed Statement

\`\`\`sql
SELECT META(\`article\`).\`id\` FROM \`article\` WHERE variantNo IN $variantNos
\`\`\`

## Summary

- Current indexes used: 1
- Recommended indexes: 0
- Recommended covering indexes: 1
- Has recommendations: true

## Current Indexes Used

\`\`\`sql
${DDL_EXISTING}
\`\`\`

## Recommended Covering Indexes

\`\`\`sql
${DDL_ARTICLE}
\`\`\`

## Raw Advisor Output

\`\`\`json
{"current": "${DDL_EXISTING.replaceAll("`", "'")}"}
\`\`\`
`;

function advisorResult(over: Partial<DataSourceResult> = {}): DataSourceResult {
	return result({
		data: `Existing index inventory:\n\n\`\`\`sql\n${DDL_EXISTING}\n\`\`\`\n\nSee advisor output.`,
		toolOutputs: [{ toolName: "capella_get_index_advisor_recommendations", rawJson: ADVISOR_MARKDOWN }],
		...over,
	});
}

describe("advisor-scoped DDL extraction (SIO-1149)", () => {
	test("extracts only Recommended-section DDL when the advisor toolOutput is present", () => {
		const { statements, source } = extractCreateIndexStatements([advisorResult()]);
		expect(source).toBe("advisor");
		expect(statements).toHaveLength(1);
		expect(statements[0]).toContain("adv_article_salesStatusCodes_covering");
		expect(statements.join("\n")).not.toContain("ARTICLE_variantNo");
	});

	test("localcore regression: the existing-index DDL in prose is never appended", () => {
		// The answer body already carries the recommendation verbatim; the existing
		// index appears only in the sub-agent prose.
		const answer = `Report body.\n\n\`\`\`sql\n${DDL_ARTICLE}\n\`\`\`\n\nConfidence: 0.81`;
		const { answer: ensured, appended, source } = ensureVerbatimDdl(answer, [advisorResult()]);
		expect(source).toBe("advisor");
		expect(appended).toHaveLength(0);
		expect(ensured).toBe(answer);
	});

	test("advisor-sourced append keeps the Index Advisor header", () => {
		const { answer, appended, source } = ensureVerbatimDdl("Report body.\n\nConfidence: 0.8", [advisorResult()]);
		expect(source).toBe("advisor");
		expect(appended).toHaveLength(1);
		expect(answer).toContain("The Index Advisor returned the following statements");
	});

	test("fallback prose scan labels provenance honestly when no advisor toolOutput exists", () => {
		const { answer, appended, source } = ensureVerbatimDdl("Report body.\n\nConfidence: 0.8", [
			result({ data: COUCHBASE_PROSE }),
		]);
		expect(source).toBe("prose");
		expect(appended).toHaveLength(2);
		expect(answer).toContain("advisor tool output was not available to verify provenance");
		expect(answer).not.toContain("The Index Advisor returned the following statements");
	});

	test("non-string advisor rawJson falls back to the prose scan", () => {
		const { source } = extractCreateIndexStatements([
			result({
				data: COUCHBASE_PROSE,
				toolOutputs: [{ toolName: "capella_get_index_advisor_recommendations", rawJson: { rows: [] } }],
			}),
		]);
		expect(source).toBe("prose");
	});
});

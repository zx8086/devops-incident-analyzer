// packages/agent/src/aggregator-verbatim-ddl.test.ts
import { describe, expect, test } from "bun:test";
import type { DataSourceResult } from "@devops-agent/shared";
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
		const statements = extractCreateIndexStatements([result({ data: COUCHBASE_PROSE })]);
		expect(statements).toHaveLength(2);
		expect(statements[0]).toContain("adv_variant_fmsSeasonCode");
		expect(statements[1]).toContain("adv_article_salesStatusCodes_covering");
	});

	test("dedups identical statements across results by normalized whitespace", () => {
		const reflowed = DDL_VARIANT.replace(/\n/g, " ");
		const statements = extractCreateIndexStatements([
			result({ data: `\`\`\`sql\n${DDL_VARIANT}\n\`\`\`` }),
			result({ data: `Advisor said: ${reflowed}\n\nDone.` }),
		]);
		expect(statements).toHaveLength(1);
	});

	test("ignores prose mentions of CREATE INDEX without the ON <keyspace>(<keys>) shape", () => {
		const statements = extractCreateIndexStatements([
			result({ data: "You should CREATE INDEX statements per the advisor.\n\nNext steps follow." }),
		]);
		expect(statements).toHaveLength(0);
	});

	test("ignores non-string result data", () => {
		expect(extractCreateIndexStatements([result({ data: {} })])).toHaveLength(0);
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

	test("appends at the end when the answer has no Confidence line", () => {
		const { answer, appended } = ensureVerbatimDdl("Report body only.", [result({ data: COUCHBASE_PROSE })]);
		expect(appended).toHaveLength(2);
		expect(answer.endsWith("```\n")).toBe(true);
		expect(answer.startsWith("Report body only.")).toBe(true);
	});
});

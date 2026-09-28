// tests/deploy-agent-iam.test.ts
import { describe, expect, test } from "bun:test";

// SIO-1884: text-level on purpose (no offline IAM evaluator); guards what the eu-oit-dev live check proved.
const tf = await Bun.file(new URL("../deploy/modules/agent/main.tf", import.meta.url)).text();

// The HCL for one statement: from its Sid to the end of its `[{ ... }]` block.
function statement(sid: string): string {
	const start = tf.indexOf(`"${sid}"`);
	expect(start).toBeGreaterThan(-1);
	const end = tf.indexOf("}],", start);
	return tf.slice(start, end);
}

describe("pi-coms-extensions: Performance Insights boundary (SIO-1884)", () => {
	test("literal SQL is explicitly denied for both read actions", () => {
		const s = statement("PerformanceInsightsLiteralSqlDeny");
		expect(s).toMatch(/Effect\s*=\s*"Deny"/);
		expect(s).toContain('"pi:GetResourceMetrics"');
		expect(s).toContain('"pi:DescribeDimensionKeys"');
		expect(s).toMatch(/"ForAnyValue:StringEquals"\s*=\s*\{\s*"pi:Dimensions"\s*=\s*\["db\.sql\.statement"\]/);
	});

	test("full statement text is never granted", () => {
		// Quoted: the action in a policy list, not the name in a comment.
		expect(tf).not.toContain('"pi:GetDimensionKeyDetails"');
		expect(tf).not.toMatch(/"pi:\*"/);
	});

	test("kms:Decrypt stays denied except for Performance Insights' own encryption context", () => {
		const s = statement("DecryptDenyExceptPerformanceInsights");
		expect(s).toMatch(/Effect\s*=\s*"Deny"/);
		expect(s).toMatch(/StringNotEquals\s*=\s*\{\s*"kms:EncryptionContext:service"\s*=\s*"pi"\s*\}/);
		expect(s).toMatch(/Resource\s*=\s*"\*"/);
	});

	test("secret values stay in the unconditional deny", () => {
		const s = statement("SecretAndDataPlaneDeny");
		expect(s).toContain('"secretsmanager:GetSecretValue"');
		expect(s).toContain('"ssm:GetParameter"');
		expect(s).not.toContain("Condition");
	});
});

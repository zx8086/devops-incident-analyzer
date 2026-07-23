// apps/web/src/lib/components/ConfidenceBadge.test.ts
// SIO-1194: the badge is the numeric confidence surface (previously the score was
// dead-ended on the message object). Capped runs must explain themselves.
import { describe, expect, test } from "bun:test";
import { render } from "svelte/server";
import ConfidenceBadge from "./ConfidenceBadge.svelte";

describe("ConfidenceBadge", () => {
	test("renders a neutral pill for an uncapped score", () => {
		const { body } = render(ConfidenceBadge, { props: { confidence: 0.87 } });
		expect(body).toContain("Confidence 0.87");
		expect(body).not.toContain("capped");
	});

	test("renders the capped variant with evidence score and reason labels", () => {
		const { body } = render(ConfidenceBadge, {
			props: {
				confidence: 0.59,
				confidencePreCap: 0.84,
				capReasons: ["degraded-subagents", "gaps"],
				lowConfidence: true,
			},
		});
		expect(body).toContain("Confidence 0.59");
		expect(body).toContain("evidence 0.84");
		expect(body).toContain("capped");
		// Collapsed state (SSR): the shared labels ride the button title; the
		// per-reason detail list only renders after a client-side toggle.
		expect(body).toContain("datasource tool errors, unresolved data gaps");
	});

	test("renders the below-threshold variant when low confidence without caps", () => {
		const { body } = render(ConfidenceBadge, { props: { confidence: 0.55, lowConfidence: true } });
		expect(body).toContain("Confidence 0.55");
		expect(body).toContain("below review threshold");
		expect(body).not.toContain("capped");
	});

	test("renders nothing without a confidence value", () => {
		const { body } = render(ConfidenceBadge, { props: {} });
		expect(body).not.toContain("Confidence");
	});
});

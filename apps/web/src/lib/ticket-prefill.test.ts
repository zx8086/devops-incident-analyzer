// apps/web/src/lib/ticket-prefill.test.ts
import { describe, expect, test } from "bun:test";
import { prefillDescription, prefillSummary } from "./ticket-prefill.ts";

describe("prefillSummary", () => {
	test("uses the first markdown heading, stripped of hashes", () => {
		expect(prefillSummary("intro text\n\n## Kafka Lag Incident\n\nbody")).toBe("Kafka Lag Incident");
	});

	test("falls back to the first non-empty line when there is no heading", () => {
		expect(prefillSummary("\n\nConsumer lag detected on orders-events.\nmore")).toBe(
			"Consumer lag detected on orders-events.",
		);
	});

	test("strips inline markdown markers", () => {
		expect(prefillSummary("# **Kafka** `lag` _alert_")).toBe("Kafka lag alert");
	});

	test("truncates to 150 characters with an ellipsis", () => {
		const summary = prefillSummary(`# ${"word ".repeat(60)}`);
		expect(summary.length).toBe(150);
		expect(summary.endsWith("...")).toBe(true);
	});

	test("empty content yields an empty summary", () => {
		expect(prefillSummary("")).toBe("");
	});
});

describe("prefillDescription", () => {
	test("passes short content through unchanged", () => {
		expect(prefillDescription("report body")).toBe("report body");
	});

	test("truncates over-long content with a marker inside the 32k cap", () => {
		const out = prefillDescription("x".repeat(40_000));
		expect(out.length).toBe(32_000);
		expect(out.endsWith("[truncated]")).toBe(true);
	});
});

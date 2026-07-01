// packages/agent/src/graph-section.test.ts
//
// SIO-1028: the Prior-Incident Recall instruction is built by the pure
// buildGraphSection helper (own module so this test is not affected by the
// process-global mock.module("./prompt-context.ts") that sibling suites register).

import { describe, expect, test } from "bun:test";
import { buildGraphSection } from "./graph-section.ts";

const GRAPH_CONTEXT = [
	"\n\n---\n\n## Knowledge Graph",
	"### Similar prior incidents",
	"- [high] kafka consumer lag on orders (id inc-1) -- prior root cause: undersized partition count",
].join("\n");

describe("buildGraphSection (SIO-1028)", () => {
	test("prepends the Prior-Incident Recall instruction when graphContext is present", () => {
		const section = buildGraphSection(GRAPH_CONTEXT);

		expect(section).toContain("## Prior-Incident Recall");
		expect(section).toContain("ANSWER FROM");
		expect(section).toContain("Similar prior incidents");
		// grounded-gaps clause (SIO-1013) must survive
		expect(section).toContain("no prior-incident record rather than guessing");
		// the already-rendered graph text is inlined verbatim after the instruction
		expect(section).toContain("prior root cause: undersized partition count");
		expect(section).toContain("## Knowledge Graph");
		expect(section.indexOf("## Prior-Incident Recall")).toBeLessThan(section.indexOf("## Knowledge Graph"));
	});

	test("returns empty string when graphContext is absent, empty, or whitespace", () => {
		expect(buildGraphSection(undefined)).toBe("");
		expect(buildGraphSection("")).toBe("");
		expect(buildGraphSection("   \n  ")).toBe("");
	});
});

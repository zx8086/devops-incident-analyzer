// packages/agent/src/sub-agent-focus-block.test.ts
//
// SIO-1079: the AWS sub-agent anchored CloudWatch query windows with no "now" reference,
// producing MalformedQueryException. buildFocusBlock now always injects a current-time
// anchor so the LLM can convert ISO/relative windows to correct epoch seconds.

import { describe, expect, test } from "bun:test";
import type { InvestigationFocus } from "@devops-agent/shared";
import { buildFocusBlock } from "./sub-agent-focus-block.ts";

const NOW = "2026-07-12T05:18:00.000Z";

describe("buildFocusBlock current-time anchor (SIO-1079)", () => {
	test("always includes the current-time line, even with no focus", () => {
		const block = buildFocusBlock(undefined, NOW);
		expect(block).toContain(`Current time: ${NOW}`);
		// Must steer epoch/window choice.
		expect(block.toLowerCase()).toContain("epoch");
		expect(block.toLowerCase()).toContain("retention");
	});

	test("SIO-1080: asserts the current YEAR authoritatively and forbids adjusting the incident year", () => {
		const block = buildFocusBlock(undefined, NOW);
		// The year derived from nowIso (2026) must appear as a standalone assertion.
		expect(block).toContain("2026");
		const low = block.toLowerCase();
		expect(low).toContain("current year");
		// Must forbid shifting/correcting the incident year.
		expect(low).toMatch(/never (shift|adjust|correct|reinterpret)/);
		expect(low).toContain("year");
	});

	test("SIO-1080: the asserted year tracks nowIso (not hardcoded)", () => {
		const low2027 = buildFocusBlock(undefined, "2027-01-02T00:00:00.000Z").toLowerCase();
		// Assert the rendered year-assertion sentence, not the echoed nowIso -- so the test fails
		// if currentYear regresses to a hardcoded value.
		expect(low2027).toContain("the current year is 2027");
		expect(low2027).not.toContain("the current year is 2026");
	});

	test("includes both the time anchor and the focus when focus is present", () => {
		const focus: InvestigationFocus = {
			services: ["localcore-service"],
			datasources: ["aws"],
			timeWindow: { from: "2026-07-11T22:00:00Z", to: "2026-07-12T00:00:00Z" },
			summary: "SoldTo fetch failures",
			establishedAtTurn: 1,
		};
		const block = buildFocusBlock(focus, NOW);
		expect(block).toContain(`Current time: ${NOW}`);
		expect(block).toContain("INVESTIGATION FOCUS");
		expect(block).toContain("localcore-service");
		expect(block).toContain("2026-07-11T22:00:00Z to 2026-07-12T00:00:00Z");
	});

	test("focus preserved with (none) placeholders when fields are empty", () => {
		const focus: InvestigationFocus = {
			services: [],
			datasources: [],
			summary: "generic",
			establishedAtTurn: 2,
		};
		const block = buildFocusBlock(focus, NOW);
		expect(block).toContain("Anchored services: (none)");
		expect(block).toContain("Anchored time window: (none)");
		expect(block).toContain(`Current time: ${NOW}`);
	});
});

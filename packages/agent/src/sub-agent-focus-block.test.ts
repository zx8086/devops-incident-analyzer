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

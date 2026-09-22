// apps/web/src/lib/landing-zone-copy.test.ts

import { describe, expect, test } from "bun:test";
import { LANDING_ZONE_BANNER, LANDING_ZONE_EMPTY_STATE, LANDING_ZONE_STARTER_PROMPTS } from "./landing-zone-copy.ts";

describe("Landing Zone presentation copy", () => {
	test("provides the six required read-only starter prompts", () => {
		expect(LANDING_ZONE_STARTER_PROMPTS).toHaveLength(6);
		expect(LANDING_ZONE_STARTER_PROMPTS.map((item) => item.id)).toEqual([
			"account-creation",
			"repository-explanation",
			"network-map",
			"dns-path",
			"gitlab-project-runners",
			"standards-comparison",
		]);

		for (const item of LANDING_ZONE_STARTER_PROMPTS) {
			expect(item.label.length).toBeGreaterThan(0);
			expect(item.prompt.length).toBeGreaterThan(0);
			expect(item.prompt).not.toMatch(/\b(terraform apply|merge|mutate|state mutation|aws mutation)\b/i);
		}
	});

	test("states the evidence and no-apply boundary", () => {
		expect(LANDING_ZONE_BANNER).toContain("live PVH evidence");
		expect(LANDING_ZONE_BANNER).toContain("never applies");
		expect(LANDING_ZONE_EMPTY_STATE).toContain("PVH Landing Zone");
	});
});

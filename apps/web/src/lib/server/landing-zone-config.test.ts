// apps/web/src/lib/server/landing-zone-config.test.ts

import { describe, expect, test } from "bun:test";
import { landingZoneTopologyAccounts } from "./landing-zone-config.ts";

describe("landingZoneTopologyAccounts", () => {
	test("returns a normalized Landing Zone-only account allowlist", () => {
		expect(
			landingZoneTopologyAccounts({
				LANDING_ZONE_TOPOLOGY_ACCOUNT_IDS: "444455556666, 111122223333,111122223333",
			} as NodeJS.ProcessEnv),
		).toEqual(["111122223333", "444455556666"]);
	});

	test("defaults to no account-specific topology access", () => {
		expect(landingZoneTopologyAccounts({} as NodeJS.ProcessEnv)).toEqual([]);
	});

	test("rejects malformed account IDs instead of broadening access", () => {
		expect(() =>
			landingZoneTopologyAccounts({
				LANDING_ZONE_TOPOLOGY_ACCOUNT_IDS: "111122223333,not-an-account",
			} as NodeJS.ProcessEnv),
		).toThrow("must be a 12-digit AWS account ID");
	});
});

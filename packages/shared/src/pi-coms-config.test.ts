// shared/src/pi-coms-config.test.ts
import { describe, expect, test } from "bun:test";
import { PiComsConfigSchema } from "./config.ts";

const hub = { serverUrl: "http://hub.test", authToken: "t", project: "default", fallbackTarget: "ops" };

describe("PiComsConfigSchema (SIO-1635 Phase 0 hubs map)", () => {
	test("accepts a partial hubs map keyed by environment", () => {
		const parsed = PiComsConfigSchema.parse({
			hubs: { prd: hub },
			estateAgentMap: {},
			verifyTimeoutMs: 1,
			investigateTimeoutMs: 1,
			// SIO-1655: capability gates are part of the config now. No .default()
			// in the schema (project rule), so a caller supplies them; the defaults
			// are applied by resolvePiComsConfig.
			capabilities: { handoff: true, inbox: true, fleetGraph: true },
		});
		expect(Object.keys(parsed.hubs)).toEqual(["prd"]);
		expect(parsed.capabilities.fleetGraph).toBe(true);
	});
	test("rejects an empty hubs map and unknown environments", () => {
		expect(() =>
			PiComsConfigSchema.parse({ hubs: {}, estateAgentMap: {}, verifyTimeoutMs: 1, investigateTimeoutMs: 1 }),
		).toThrow();
		expect(() =>
			PiComsConfigSchema.parse({ hubs: { qa: hub }, estateAgentMap: {}, verifyTimeoutMs: 1, investigateTimeoutMs: 1 }),
		).toThrow();
	});
});

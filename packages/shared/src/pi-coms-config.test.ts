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
		});
		expect(Object.keys(parsed.hubs)).toEqual(["prd"]);
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

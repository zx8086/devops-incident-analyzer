// shared/src/pi-coms-config.test.ts
import { describe, expect, test } from "bun:test";
import { PiComsConfigSchema } from "./config.ts";

// SIO-1666: a hub declares the environment it serves and the estates it owns.
const hub = {
	serverUrl: "http://hub.test",
	authToken: "t",
	project: "default",
	fallbackTarget: "ops",
	environment: "prd",
	estates: ["eu-oit-prd"],
};

describe("PiComsConfigSchema (SIO-1635 Phase 0 hubs map)", () => {
	test("accepts a hubs map keyed by selector (SIO-1666)", () => {
		const parsed = PiComsConfigSchema.parse({
			hubs: { "eu-shared-services-prd": hub },
			estateAgentMap: {},
			verifyTimeoutMs: 1,
			investigateTimeoutMs: 1,
			// SIO-1655: capability gates are part of the config now. No .default()
			// in the schema (project rule), so a caller supplies them; the defaults
			// are applied by resolvePiComsConfig.
			capabilities: { handoff: true, inbox: true, fleetGraph: true },
		});
		expect(Object.keys(parsed.hubs)).toEqual(["eu-shared-services-prd"]);
		expect(parsed.hubs["eu-shared-services-prd"]?.environment).toBe("prd");
		expect(parsed.capabilities.fleetGraph).toBe(true);
	});
	test("rejects an empty hubs map and a hub missing its environment", () => {
		expect(() =>
			PiComsConfigSchema.parse({ hubs: {}, estateAgentMap: {}, verifyTimeoutMs: 1, investigateTimeoutMs: 1 }),
		).toThrow();
		expect(() =>
			PiComsConfigSchema.parse({
				// SIO-1666: any KEY is allowed (it is a selector), but a hub must
				// still declare a valid environment and its estates.
				hubs: { "eu-shared-services-prd": { ...hub, environment: "qa" } },
				estateAgentMap: {},
				verifyTimeoutMs: 1,
				investigateTimeoutMs: 1,
			}),
		).toThrow();
	});
});

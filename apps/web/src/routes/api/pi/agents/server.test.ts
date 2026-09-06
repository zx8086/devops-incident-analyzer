// apps/web/src/routes/api/pi/agents/server.test.ts
// SIO-1650: the pane's agent listing route. The server module is the mocked
// boundary here; its own tests cover the hub traffic.
import { describe, expect, mock, test } from "bun:test";

const listing = {
	configured: true,
	senderPrefix: "pi-fleet",
	awaitMs: 25_000,
	totalBudgetMs: 300_000,
	hubs: [{ environment: "dev", project: "default", fallbackTarget: "ops", peers: [], error: null }],
};
let failWith: Error | undefined;

mock.module("$lib/server/pi-fleet", () => ({
	PiFleetRequestError: class PiFleetRequestError extends Error {
		status = 404;
	},
	listFleetAgents: async () => {
		if (failWith) throw failWith;
		return listing;
	},
}));

const { GET } = await import("./+server.ts");

describe("GET /api/pi/agents", () => {
	test("returns the listing as JSON", async () => {
		const res = await GET({} as never);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual(listing);
	});

	test("a configuration error is a 500 with the message, never a hidden empty pane", async () => {
		failWith = new Error("PI_COMS_PANE_TOKENS is not valid JSON: oops");
		try {
			const res = await GET({} as never);
			expect(res.status).toBe(500);
			expect((await res.json()).error).toContain("PI_COMS_PANE_TOKENS");
		} finally {
			failWith = undefined;
		}
	});
});

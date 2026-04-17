// test/get-incident-history.test.ts
import { describe, expect, test } from "bun:test";
import type { AtlassianMcpProxy } from "../src/atlassian-client/index.js";
import { bucketKey, aggregate, getIncidentHistory } from "../src/tools/custom/get-incident-history.js";

describe("getIncidentHistory.bucketKey", () => {
	test("weekly bucket is ISO week start (Monday)", () => {
		expect(bucketKey(new Date("2026-04-15T12:00:00Z"), "week")).toBe("2026-04-13");
	});

	test("monthly bucket is YYYY-MM-01", () => {
		expect(bucketKey(new Date("2026-04-15T12:00:00Z"), "month")).toBe("2026-04-01");
	});
});

describe("getIncidentHistory.aggregate", () => {
	test("computes per-bucket count, total MTTR, unresolved count", () => {
		const issues = [
			{ fields: { created: "2026-04-13T10:00:00Z", resolutiondate: "2026-04-13T11:00:00Z" } },
			{ fields: { created: "2026-04-14T10:00:00Z", resolutiondate: null } },
			{ fields: { created: "2026-04-21T10:00:00Z", resolutiondate: "2026-04-21T10:30:00Z" } },
		];
		const out = aggregate(issues, 30, "week", "svc");
		expect(out.totals.incidentCount).toBe(3);
		expect(out.totals.unresolvedCount).toBe(1);
		expect(out.totals.mttrMinutes).toBe(45);
		expect(out.buckets.length).toBe(2);
	});

	test("mttrMinutes is null when all issues unresolved", () => {
		const issues = [{ fields: { created: "2026-04-13T10:00:00Z", resolutiondate: null } }];
		const out = aggregate(issues, 30, "week", "svc");
		expect(out.totals.mttrMinutes).toBeNull();
	});

	test("empty issues returns zero counts", () => {
		const out = aggregate([], 30, "week", "svc");
		expect(out.totals.incidentCount).toBe(0);
		expect(out.totals.unresolvedCount).toBe(0);
		expect(out.totals.mttrMinutes).toBeNull();
		expect(out.buckets).toEqual([]);
	});
});

describe("getIncidentHistory (end-to-end)", () => {
	test("end-to-end via mock proxy", async () => {
		const fakeProxy = {
			callTool: async () => ({
				content: [
					{
						type: "text",
						text: JSON.stringify({
							issues: [
								{ fields: { created: "2026-04-13T10:00:00Z", resolutiondate: "2026-04-13T11:00:00Z" } },
							],
						}),
					},
				],
			}),
		} as unknown as AtlassianMcpProxy;
		const out = await getIncidentHistory(fakeProxy, {
			service: "svc",
			windowDays: 30,
			groupBy: "week",
			incidentProjects: ["INC"],
		});
		expect(out.totals.incidentCount).toBe(1);
		expect(out.buckets).toHaveLength(1);
	});
});

// test/find-linked-incidents.test.ts
import { describe, expect, test } from "bun:test";
import type { AtlassianMcpProxy } from "../src/atlassian-client/index.js";
import { buildJql, shapeIssue, findLinkedIncidents } from "../src/tools/custom/find-linked-incidents.js";

describe("findLinkedIncidents.buildJql", () => {
	test("constrains to incidentProjects when provided", () => {
		const jql = buildJql({
			service: "checkout-api",
			componentLabel: undefined,
			withinDays: 30,
			incidentProjects: ["INC", "OPS"],
		});
		expect(jql).toContain("project in (INC, OPS)");
		expect(jql).toContain('labels = "checkout-api"');
		expect(jql).toContain("created >= -30d");
	});

	test("falls back when incidentProjects empty", () => {
		const jql = buildJql({ service: "x", componentLabel: undefined, withinDays: 7, incidentProjects: [] });
		expect(jql).toContain("project is not EMPTY");
	});
});

describe("findLinkedIncidents.shapeIssue", () => {
	test("extracts severity from priority.name first", () => {
		const shaped = shapeIssue({
			key: "INC-1",
			fields: {
				summary: "db timeout",
				status: { name: "Resolved" },
				priority: { name: "High" },
				customfield_severity: { value: "Critical" },
				created: "2026-04-10T10:00:00Z",
				resolutiondate: "2026-04-10T11:30:00Z",
			},
		});
		expect(shaped.severity).toBe("High");
		expect(shaped.mttrMinutes).toBe(90);
		expect(shaped.key).toBe("INC-1");
	});

	test("falls back to customfield_severity when priority missing", () => {
		const shaped = shapeIssue({
			key: "INC-2",
			fields: {
				summary: "s",
				status: { name: "Open" },
				priority: null,
				customfield_severity: { value: "Sev2" },
				created: "2026-04-10T10:00:00Z",
				resolutiondate: null,
			},
		});
		expect(shaped.severity).toBe("Sev2");
		expect(shaped.mttrMinutes).toBeNull();
		expect(shaped.resolvedAt).toBeNull();
	});

	test("severity null when both missing", () => {
		const shaped = shapeIssue({
			key: "INC-3",
			fields: { summary: "s", status: { name: "Open" }, created: "2026-04-10T10:00:00Z" },
		});
		expect(shaped.severity).toBeNull();
	});
});

describe("findLinkedIncidents (end-to-end with mock proxy)", () => {
	test("returns shaped issues via proxy.callTool", async () => {
		const fakeProxy = {
			callTool: async () => ({
				content: [
					{
						type: "text",
						text: JSON.stringify({
							issues: [
								{
									key: "INC-1",
									fields: {
										summary: "checkout down",
										status: { name: "Resolved" },
										priority: { name: "High" },
										created: "2026-04-10T10:00:00Z",
										resolutiondate: "2026-04-10T10:30:00Z",
									},
								},
							],
						}),
					},
				],
			}),
		} as unknown as AtlassianMcpProxy;
		const result = await findLinkedIncidents(fakeProxy, {
			service: "checkout-api",
			withinDays: 30,
			limit: 10,
			incidentProjects: ["INC"],
			siteUrl: "https://tommy.atlassian.net",
		});
		expect(result.count).toBe(1);
		expect(result.issues[0].key).toBe("INC-1");
		expect(result.issues[0].url).toBe("https://tommy.atlassian.net/browse/INC-1");
		expect(result.issues[0].mttrMinutes).toBe(30);
	});
});

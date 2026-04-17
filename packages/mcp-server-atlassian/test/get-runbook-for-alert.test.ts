// test/get-runbook-for-alert.test.ts
import { describe, expect, test } from "bun:test";
import type { AtlassianMcpProxy } from "../src/atlassian-client/index.js";
import { buildCql, getRunbookForAlert, scorePage } from "../src/tools/custom/get-runbook-for-alert.js";

describe("getRunbookForAlert.buildCql", () => {
	test("includes service and keywords joined with OR", () => {
		const cql = buildCql({ service: "checkout-api", errorKeywords: ["timeout", "502"], spaceKey: undefined });
		expect(cql).toContain('text ~ "checkout-api"');
		expect(cql).toContain('text ~ "timeout"');
		expect(cql).toContain('text ~ "502"');
	});

	test("scopes to space when provided", () => {
		const cql = buildCql({ service: "svc", errorKeywords: ["err"], spaceKey: "RUNBOOKS" });
		expect(cql).toContain('space = "RUNBOOKS"');
	});
});

describe("getRunbookForAlert.scorePage", () => {
	test("title with service scores higher than body-only match", () => {
		const withTitle = scorePage(
			{ title: "Checkout-API Runbook", labels: ["runbook"], lastUpdated: new Date().toISOString(), excerpt: "" },
			"checkout-api",
			["timeout"],
		);
		const bodyOnly = scorePage(
			{ title: "Some Other Page", labels: [], lastUpdated: new Date().toISOString(), excerpt: "" },
			"checkout-api",
			["timeout"],
		);
		expect(withTitle).toBeGreaterThan(bodyOnly);
	});

	test("runbook label adds score", () => {
		const withLabel = scorePage(
			{ title: "Page", labels: ["runbook"], lastUpdated: "2020-01-01T00:00:00Z", excerpt: "" },
			"svc",
			["err"],
		);
		const withoutLabel = scorePage(
			{ title: "Page", labels: [], lastUpdated: "2020-01-01T00:00:00Z", excerpt: "" },
			"svc",
			["err"],
		);
		expect(withLabel).toBeGreaterThan(withoutLabel);
	});

	test("recent update (within 90d) adds score", () => {
		const recent = scorePage({ title: "Page", labels: [], lastUpdated: new Date().toISOString(), excerpt: "" }, "svc", [
			"err",
		]);
		const stale = scorePage({ title: "Page", labels: [], lastUpdated: "2020-01-01T00:00:00Z", excerpt: "" }, "svc", [
			"err",
		]);
		expect(recent).toBeGreaterThan(stale);
	});
});

describe("getRunbookForAlert (end-to-end)", () => {
	test("orders results by relevance score desc and respects limit", async () => {
		const fakeProxy = {
			callTool: async () => ({
				content: [
					{
						type: "text",
						text: JSON.stringify({
							results: [
								{
									id: "p1",
									title: "Unrelated Page",
									spaceKey: "DOCS",
									labels: [],
									lastUpdated: "2020-01-01T00:00:00Z",
									excerpt: "",
								},
								{
									id: "p2",
									title: "checkout-api Runbook",
									spaceKey: "OPS",
									labels: ["runbook"],
									lastUpdated: new Date().toISOString(),
									excerpt: "",
								},
							],
						}),
					},
				],
			}),
		} as unknown as AtlassianMcpProxy;
		const out = await getRunbookForAlert(fakeProxy, {
			service: "checkout-api",
			errorKeywords: ["timeout"],
			spaceKey: undefined,
			limit: 5,
			siteUrl: "https://tommy.atlassian.net/wiki",
		});
		expect(out.matches[0].title).toBe("checkout-api Runbook");
		expect(out.matches[0].relevanceScore).toBeGreaterThan(out.matches[1].relevanceScore);
	});
});

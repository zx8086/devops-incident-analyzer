// test/get-runbook-for-alert.test.ts
import { describe, expect, test } from "bun:test";
import type { AtlassianMcpProxy } from "../src/atlassian-client/index.js";
import {
	buildCql,
	buildErrorCql,
	buildRunbookCql,
	getRunbookForAlert,
	scorePage,
	shapePage,
} from "../src/tools/custom/get-runbook-for-alert.js";

// SIO-1806: one result in the shape the live searchConfluenceUsingCql returns (captured from the
// upstream, keys kept, values synthetic). The fixtures here used to supply a flat
// {id, spaceKey, labels, lastUpdated} shape that the upstream never sends, which is why the tool
// shipped returning undefined ids and `/spaces/undefined/pages/undefined` links with green tests.
function upstreamResult(o: { id: string; title: string; space?: string; labels?: string[]; lastModified?: string }) {
	return {
		content: {
			id: o.id,
			type: "page",
			status: "current",
			title: o.title,
			metadata: { labels: { results: (o.labels ?? []).map((name) => ({ prefix: "global", name })), size: 0 } },
			_links: {},
		},
		title: o.title.replace(/>/g, "&gt;"),
		excerpt: "how to recover the service",
		url: `/spaces/${(o.space ?? "OPS").toLowerCase()}/pages/${o.id}/Some+Page`,
		resultGlobalContainer: { title: "Operations", displayUrl: `/spaces/${o.space ?? "OPS"}` },
		entityType: "content",
		lastModified: o.lastModified ?? "2020-01-01T00:00:00.000Z",
		score: 0,
	};
}

function envelope(results: unknown[], extra: Record<string, unknown> = {}) {
	return {
		content: [{ type: "text", text: JSON.stringify({ results, start: 0, limit: 25, size: results.length, ...extra }) }],
	};
}

// Answers each upstream call from the first matching handler, keyed on a substring of the CQL.
function proxyFor(handlers: Array<[string, () => unknown]>, calls: Array<Record<string, unknown>> = []) {
	return {
		callTool: async (_name: string, args: Record<string, unknown>) => {
			calls.push(args);
			const hit = handlers.find(([needle]) => String(args.cql).includes(needle));
			if (!hit) throw new Error(`no handler for ${String(args.cql)}`);
			return hit[1]();
		},
	} as unknown as AtlassianMcpProxy;
}

describe("getRunbookForAlert CQL builders", () => {
	const args = { service: "checkout-api", errorKeywords: ["kv timeout", "502"], spaceKey: undefined };

	test("SIO-1806: a keyword with whitespace is a phrase, a single word and the service are not", () => {
		for (const cql of [buildRunbookCql(args), buildErrorCql(args) ?? "", buildCql(args)]) {
			expect(cql).toContain('text ~ "\\"kv timeout\\""');
			expect(cql).not.toContain('text ~ "kv timeout"');
			expect(cql).toContain('text ~ "502"');
			expect(cql).toContain('text ~ "checkout-api"');
			expect(cql).not.toContain('"\\"checkout-api\\""');
		}
	});

	test("SIO-1806: no recency ordering, pages only", () => {
		for (const cql of [buildRunbookCql(args), buildErrorCql(args) ?? "", buildCql(args)]) {
			expect(cql).not.toContain("ORDER BY");
			expect(cql).toContain("type = page");
		}
	});

	test("the runbook query requires a runbook-like label or title word", () => {
		const cql = buildRunbookCql(args);
		expect(cql).toContain('label in ("runbook", "kb-how-to-article", "kb-troubleshooting-article")');
		expect(cql).toContain('title ~ "playbook"');
		expect(cql).toContain('title ~ "checkout-api"');
		expect(cql).toMatch(/^\(.+\) AND \(label in /);
	});

	test("the error query lets a phrase stand alone but ties a single word to the service", () => {
		expect(buildErrorCql(args)).toBe(
			'(text ~ "\\"kv timeout\\"" OR (text ~ "checkout-api" AND (text ~ "502"))) AND type = page',
		);
	});

	test("the error query is null without keywords", () => {
		expect(buildErrorCql({ service: "svc", errorKeywords: [" ", ""], spaceKey: undefined })).toBeNull();
	});

	test("scopes every query to the space when provided", () => {
		const scoped = { service: "svc", errorKeywords: ["err"], spaceKey: "RUNBOOKS" };
		for (const cql of [buildRunbookCql(scoped), buildErrorCql(scoped) ?? "", buildCql(scoped)]) {
			expect(cql).toContain('space = "RUNBOOKS"');
		}
	});

	test("SIO-1093: the fallback also matches terms in the title", () => {
		const cql = buildCql({ service: "checkout-api", errorKeywords: ["AFS season code"], spaceKey: undefined });
		expect(cql).toContain('title ~ "checkout-api"');
		expect(cql).toContain('title ~ "\\"AFS season code\\""');
	});

	test("SIO-1093: blank/whitespace-only terms are dropped entirely", () => {
		const cql = buildCql({ service: "svc", errorKeywords: ["", " ", "\t"], spaceKey: undefined });
		expect(cql).toBe('(text ~ "svc" OR title ~ "svc") AND type = page');
	});

	test("SIO-1093 (CodeRabbit): caps and dedupes errorKeywords", () => {
		// The duplicate kw0 must sit BEFORE the 8-term cap so the dedup path is actually exercised.
		const rest = Array.from({ length: 7 }, (_, i) => `kw${i + 1}`);
		const cql = buildCql({ service: "svc", errorKeywords: ["kw0", "kw0", ...rest], spaceKey: undefined });
		expect((cql.match(/text ~ /g) ?? []).length).toBe(9);
		expect(cql).toContain('text ~ "kw7"');
		expect((cql.match(/text ~ "kw0"/g) ?? []).length).toBe(1);
	});

	test("a quote in a term cannot break out of the CQL string", () => {
		expect(buildCql({ service: 'a"b', errorKeywords: [], spaceKey: undefined })).toContain('text ~ "a\\"b"');
	});
});

describe("getRunbookForAlert.shapePage (SIO-1806)", () => {
	test("reads the real upstream shape", () => {
		const page = shapePage(
			upstreamResult({
				id: "42",
				title: "A > B Guide",
				space: "COPS",
				labels: ["kb-how-to-article"],
				lastModified: "2026-01-23T10:00:00.000Z",
			}),
			"https://example.atlassian.net",
		);
		expect(page).toEqual({
			id: "42",
			title: "A > B Guide",
			spaceKey: "COPS",
			labels: ["kb-how-to-article"],
			lastUpdated: "2026-01-23T10:00:00.000Z",
			excerpt: "how to recover the service",
			url: "https://example.atlassian.net/wiki/spaces/cops/pages/42/Some+Page",
		});
	});

	test("a sparse result yields empty strings, never undefined", () => {
		expect(shapePage({ title: "Only a title" })).toEqual({
			id: "",
			title: "Only a title",
			spaceKey: "",
			labels: [],
			lastUpdated: "",
			excerpt: "",
			url: undefined,
		});
	});
});

describe("getRunbookForAlert.scorePage", () => {
	const old = "2020-01-01T00:00:00Z";

	test("title with service scores higher than body-only match", () => {
		const withTitle = scorePage(
			{ title: "Checkout-API Runbook", labels: [], lastUpdated: old, excerpt: "" },
			"checkout-api",
			[],
		);
		const bodyOnly = scorePage(
			{ title: "Some Other Page", labels: [], lastUpdated: old, excerpt: "" },
			"checkout-api",
			[],
		);
		expect(withTitle).toBeGreaterThan(bodyOnly);
	});

	test("SIO-1806: each runbook-like signal adds score, and they do not stack", () => {
		const plain = scorePage({ title: "Page", labels: [], lastUpdated: old, excerpt: "" }, "svc", []);
		for (const labels of [["runbook"], ["kb-how-to-article"], ["KB-Troubleshooting-Article"]]) {
			expect(scorePage({ title: "Page", labels, lastUpdated: old, excerpt: "" }, "svc", [])).toBe(plain + 3);
		}
		for (const title of ["Orders - Playbook", "X - Support Guide", "Pipeline Troubleshooting Steps", "Runbooks"]) {
			expect(scorePage({ title, labels: [], lastUpdated: old, excerpt: "" }, "svc", [])).toBe(plain + 3);
		}
		expect(scorePage({ title: "Support Guide", labels: ["runbook"], lastUpdated: old, excerpt: "" }, "svc", [])).toBe(
			plain + 3,
		);
		// A word that merely contains one of them is not a signal.
		expect(scorePage({ title: "Unsupported devices", labels: [], lastUpdated: old, excerpt: "" }, "svc", [])).toBe(
			plain,
		);
	});

	// SIO-744: upstream sometimes omits `labels`; previously crashed on `page.labels.map`.
	test("tolerates page with missing labels field", () => {
		const score = scorePage(
			{ title: "Page", lastUpdated: new Date().toISOString(), excerpt: "" } as Parameters<typeof scorePage>[0],
			"svc",
			["err"],
		);
		expect(score).toBeGreaterThanOrEqual(0);
	});

	test("recent update (within 90d) adds score, and a missing date does not", () => {
		const page = { title: "Page", labels: [], excerpt: "" };
		const stale = scorePage({ ...page, lastUpdated: old }, "svc", []);
		expect(scorePage({ ...page, lastUpdated: new Date().toISOString() }, "svc", [])).toBe(stale + 1);
		expect(scorePage({ ...page, lastUpdated: "" }, "svc", [])).toBe(stale);
	});
});

describe("getRunbookForAlert (end to end over the real result shape)", () => {
	const ctx = { service: "checkout-api", errorKeywords: ["kv timeout"], spaceKey: undefined, limit: 2 };

	test("merges both queries, dedupes by page id, ranks, and asks the upstream for labels", async () => {
		const calls: Array<Record<string, unknown>> = [];
		const proxy = proxyFor(
			[
				[
					"label in",
					() =>
						envelope([
							upstreamResult({ id: "1", title: "Orders - Playbook" }),
							upstreamResult({ id: "2", title: "checkout-api Support Guide" }),
						]),
				],
				[
					"kv timeout",
					() =>
						envelope([
							upstreamResult({ id: "2", title: "checkout-api Support Guide" }),
							upstreamResult({ id: "3", title: "Architecture" }),
						]),
				],
			],
			calls,
		);
		const out = await getRunbookForAlert(proxy, { ...ctx, siteUrl: "https://example.atlassian.net" });
		expect(out.matches.map((m) => m.id)).toEqual(["2", "1"]);
		expect(out.matches[0].url).toBe("https://example.atlassian.net/wiki/spaces/ops/pages/2/Some+Page");
		expect(out.matches[0].spaceKey).toBe("OPS");
		expect(out.fallbackCql).toBeUndefined();
		expect(out.errorCql).toContain("kv timeout");
		expect(calls).toHaveLength(2);
		for (const c of calls) expect(c.expand).toBe("content.metadata.labels");
	});

	test("the broad fallback runs only when the focused queries leave slots empty", async () => {
		const calls: Array<Record<string, unknown>> = [];
		const proxy = proxyFor(
			[
				["label in", () => envelope([upstreamResult({ id: "1", title: "Orders - Playbook" })])],
				[
					'title ~ "checkout-api" OR title',
					() => envelope([upstreamResult({ id: "9", title: "checkout-api overview" })]),
				],
				["kv timeout", () => envelope([])],
			],
			calls,
		);
		const out = await getRunbookForAlert(proxy, ctx);
		expect(calls).toHaveLength(3);
		expect(out.fallbackCql).toBe(buildCql(ctx));
		expect(out.matches.map((m) => m.id).sort()).toEqual(["1", "9"]);
	});

	test("one failing query does not discard the other, and the result says which failed", async () => {
		const proxy = proxyFor([
			[
				"label in",
				() => {
					throw new Error("upstream 500");
				},
			],
			[
				"kv timeout",
				() =>
					envelope([upstreamResult({ id: "3", title: "Architecture" }), upstreamResult({ id: "4", title: "Design" })]),
			],
		]);
		const out = await getRunbookForAlert(proxy, ctx);
		expect(out.matches.map((m) => m.id)).toEqual(["3", "4"]);
		expect(out.warnings).toHaveLength(1);
		expect(out.warnings?.[0]).toContain("runbook-like pages about checkout-api failed");
	});

	test("SIO-704: tolerates extra pagination fields at the top level", async () => {
		const proxy = proxyFor([
			[
				"type = page",
				() => envelope([upstreamResult({ id: "1", title: "Runbook" })], { isLast: false, nextPageToken: "abc" }),
			],
		]);
		const out = await getRunbookForAlert(proxy, { service: "svc", errorKeywords: [], spaceKey: undefined, limit: 1 });
		expect(out.matches).toHaveLength(1);
	});

	test("SIO-704: walks past a non-JSON preamble block to find the JSON body", async () => {
		const body = envelope([upstreamResult({ id: "1", title: "Runbook" })]).content[0];
		const proxy = proxyFor([["type = page", () => ({ content: [{ type: "text", text: "Found 1 page:" }, body] })]]);
		const out = await getRunbookForAlert(proxy, { service: "svc", errorKeywords: [], spaceKey: undefined, limit: 1 });
		expect(out.matches).toHaveLength(1);
	});

	test("SIO-704: propagates AtlassianAuthRequiredError instead of silently emptying matches", async () => {
		const proxy = proxyFor([
			[
				"type = page",
				() => ({
					isError: true,
					content: [{ type: "text", text: "ATLASSIAN_AUTH_REQUIRED: Atlassian authorization expired." }],
				}),
			],
		]);
		await expect(
			getRunbookForAlert(proxy, { service: "svc", errorKeywords: [], spaceKey: undefined, limit: 5 }),
		).rejects.toThrow("ATLASSIAN_AUTH_REQUIRED");
	});
});

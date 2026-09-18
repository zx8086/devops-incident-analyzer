// src/tools/custom/get-runbook-for-alert.ts

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AtlassianMcpProxy } from "../../atlassian-client/index.js";
import { createContextLogger } from "../../utils/logger.js";
import { traceToolCall } from "../../utils/tracing.js";
import { CUSTOM_READ_ONLY_ANNOTATIONS } from "../annotations.js";
import { toolErrorResult } from "../error-envelope.js";
import { errorKeywordsField, isPhraseKeyword, sanitizeErrorKeywords } from "./find-linked-incidents.js";
import { parseAtlassianTextContent } from "./parse-atlassian-content.js";

const log = createContextLogger("get-runbook-for-alert");

function escapeCqlString(value: string): string {
	return value.replace(/[\\"]/g, "\\$&");
}

const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1_000;

// SIO-1806: what makes a page runbook-LIKE. `runbook` was the only label scored, and live it is on
// one page of the whole site; the two `kb-*` labels are what Confluence's own How-to and
// Troubleshooting blueprints apply, so they are generic, not site-specific. Title words cover the
// pages nobody labelled ("X - Support Guide", "Orders - Playbook").
export const RUNBOOK_LABELS = ["runbook", "kb-how-to-article", "kb-troubleshooting-article"] as const;
export const RUNBOOK_TITLE_WORDS = ["runbook", "playbook", "support", "guide", "troubleshooting"] as const;
const RUNBOOK_TITLE_RE = /\b(runbooks?|playbooks?|support|guides?|troubleshoot(ing)?)\b/i;

export const InputSchema = z.object({
	service: z.string().describe("Service name to find runbooks for"),
	errorKeywords: errorKeywordsField.describe("Error keywords to include in the search"),
	spaceKey: z.string().optional().describe("Confluence space key to scope the search"),
	limit: z.number().int().positive().default(5).describe("Maximum number of runbook pages to return"),
	siteUrl: z.string().optional().describe("Atlassian Confluence base URL for building page links"),
});

const ConfluencePageSchema = z.object({
	id: z.string(),
	title: z.string(),
	spaceKey: z.string(),
	labels: z.array(z.string()),
	lastUpdated: z.string(),
	excerpt: z.string(),
});

const MatchedPageSchema = ConfluencePageSchema.extend({
	relevanceScore: z.number(),
	url: z.string().optional(),
});

export const OutputSchema = z.object({
	service: z.string(),
	cql: z.string(),
	errorCql: z.string().optional(),
	fallbackCql: z.string().optional(),
	matches: z.array(MatchedPageSchema),
	warnings: z.array(z.string()).optional(),
});

export type GetRunbookForAlertInput = z.infer<typeof InputSchema>;
export type GetRunbookForAlertOutput = z.infer<typeof OutputSchema>;
export type ConfluencePage = z.infer<typeof ConfluencePageSchema>;

export interface BuildCqlArgs {
	service: string;
	errorKeywords: string[];
	spaceKey: string | undefined;
}

export interface GetRunbookContext {
	service: string;
	errorKeywords: string[];
	spaceKey?: string;
	limit: number;
	siteUrl?: string;
}

// SIO-1806: CQL `~ "a b"` is a stemmed bag of words, as in JQL (measured: `title ~ "AFS season
// code"` matched "AFS vs FMS season coding"; `text ~ "styles scope"` matched 317 pages, 0 as a
// phrase). A keyword with whitespace is searched as a phrase. The SERVICE never is: a deployment
// name like `a-b-c-v3` matches 0 pages as a phrase and 45 as words, and words is what finds it.
function clause(field: "text" | "title", term: string, phrase: boolean): string {
	const escaped = escapeCqlString(term);
	return phrase ? `${field} ~ "\\"${escaped}\\""` : `${field} ~ "${escaped}"`;
}

function finish(match: string, spaceKey: string | undefined): string {
	const parts = [match, "type = page"];
	if (spaceKey) parts.push(`space = "${escapeCqlString(spaceKey)}"`);
	// No ORDER BY: Confluence then orders by relevance. `ORDER BY lastModified DESC` handed
	// scorePage the 25 most recently EDITED of (measured) 3376 matches: sprint retrospectives.
	return parts.join(" AND ");
}

// Query 1: runbook-like pages about the service OR citing one of the keywords. The runbook-like
// filter is what keeps it small, so generic keywords are safe here. Measured on two real
// incidents: 21 + 36 and 2 + 7 pages, all support guides, playbooks and troubleshooting pages
// (one of them the datastore troubleshooting page a timeout incident needed), where the old broad
// OR returned none in the 25 it saw.
export function buildRunbookCql({ service, errorKeywords, spaceKey }: BuildCqlArgs): string {
	const svc = service.trim();
	const about = [
		...(svc.length > 0 ? [clause("title", svc, false), clause("text", svc, false)] : []),
		...sanitizeErrorKeywords(errorKeywords).map((k) => clause("text", k, isPhraseKeyword(k))),
	];
	const labels = RUNBOOK_LABELS.map((l) => `"${l}"`).join(", ");
	const titleWords = RUNBOOK_TITLE_WORDS.map((w) => `title ~ "${w}"`).join(" OR ");
	const runbookLike = `(label in (${labels}) OR ${titleWords})`;
	return finish(about.length > 0 ? `(${about.join(" OR ")}) AND ${runbookLike}` : runbookLike, spaceKey);
}

// Query 2: pages that cite the error. A phrase is distinctive and stands alone; a single word
// ("FMS", "timeout") is not, and OR-ed over full text it swamps everything, so it must co-occur
// with the service. Null when there is no keyword to search for.
export function buildErrorCql({ service, errorKeywords, spaceKey }: BuildCqlArgs): string | null {
	const keywords = sanitizeErrorKeywords(errorKeywords);
	const phrases = keywords.filter(isPhraseKeyword).map((k) => clause("text", k, true));
	const words = keywords.filter((k) => !isPhraseKeyword(k)).map((k) => clause("text", k, false));
	const svc = service.trim();
	if (words.length > 0) {
		phrases.push(
			svc.length > 0 ? `(${clause("text", svc, false)} AND (${words.join(" OR ")}))` : `(${words.join(" OR ")})`,
		);
	}
	return phrases.length > 0 ? finish(`(${phrases.join(" OR ")})`, spaceKey) : null;
}

// The fallback, run only when the two focused queries leave slots empty: every term in text OR
// title (SIO-1093: a runbook is often titled by the domain concept, not the service token).
export function buildCql({ service, errorKeywords, spaceKey }: BuildCqlArgs): string {
	const svc = service.trim();
	const terms = [
		...(svc.length > 0 ? [{ term: svc, phrase: false }] : []),
		...sanitizeErrorKeywords(errorKeywords).map((term) => ({ term, phrase: isPhraseKeyword(term) })),
	];
	const textTerms = terms.map((t) => clause("text", t.term, t.phrase));
	const titleTerms = terms.map((t) => clause("title", t.term, t.phrase));
	return finish(`(${[...textTerms, ...titleTerms].join(" OR ")})`, spaceKey);
}

export function scorePage(
	page: Pick<ConfluencePage, "title" | "labels" | "lastUpdated" | "excerpt">,
	service: string,
	keywords: string[],
): number {
	let score = 0;

	const titleLower = page.title.toLowerCase();
	if (titleLower.includes(service.toLowerCase())) score += 3;

	for (const kw of keywords) {
		if (titleLower.includes(kw.toLowerCase())) score += 2;
	}

	// SIO-744: upstream Confluence sometimes omits `labels`; treat missing as empty.
	const labelNames = (page.labels ?? []).map((l) => l.toLowerCase());
	const runbookLabels: readonly string[] = RUNBOOK_LABELS;
	if (labelNames.some((l) => runbookLabels.includes(l)) || RUNBOOK_TITLE_RE.test(page.title)) score += 3;

	const ageMs = Date.now() - new Date(page.lastUpdated).getTime();
	if (ageMs < NINETY_DAYS_MS) score += 1;

	return score;
}

// SIO-1806: the REAL shape of a searchConfluenceUsingCql result, captured from the live upstream.
// The tool used to read `id`, `spaceKey`, `labels` and `lastUpdated` off the top level, none of
// which exist, so every match had an undefined id, a `/spaces/undefined/pages/undefined` link and
// no freshness or label score; the test fixtures supplied the imagined shape, so nothing failed.
interface ConfluenceSearchResult {
	title?: string;
	excerpt?: string;
	url?: string;
	lastModified?: string;
	resultGlobalContainer?: { displayUrl?: string };
	content?: { id?: string; title?: string; metadata?: { labels?: { results?: Array<{ name?: string }> } } };
}

// SIO-704: tolerate pagination fields and anything else the upstream adds at the top level.
interface ConfluenceSearchResponse {
	results?: ConfluenceSearchResult[];
}

export function shapePage(raw: ConfluenceSearchResult, siteUrl?: string): ConfluencePage & { url?: string } {
	return {
		id: raw.content?.id ?? "",
		// The top-level `title` is HTML-escaped ("A &gt; B"); `content.title` is the plain one.
		title: raw.content?.title ?? raw.title ?? "",
		// displayUrl is "/spaces/KEY"; the key in `url` can be a lowercase alias, so it is not used.
		spaceKey: raw.resultGlobalContainer?.displayUrl?.split("/").pop() ?? "",
		labels: (raw.content?.metadata?.labels?.results ?? []).flatMap((l) => (l.name ? [l.name] : [])),
		lastUpdated: raw.lastModified ?? "",
		excerpt: raw.excerpt ?? "",
		url: siteUrl && raw.url ? `${siteUrl}/wiki${raw.url}` : undefined,
	};
}

async function searchPages(proxy: AtlassianMcpProxy, cql: string): Promise<ConfluenceSearchResult[] | null> {
	// Labels are not in a search result unless expanded.
	const result = await proxy.callTool("searchConfluenceUsingCql", { cql, expand: "content.metadata.labels" });
	const parsed = parseAtlassianTextContent<ConfluenceSearchResponse>(result as { content?: unknown }, {
		upstreamTool: "searchConfluenceUsingCql",
		context: { cql },
		log,
	});
	return parsed ? (parsed.results ?? []) : null;
}

function describeFailure(r: PromiseSettledResult<unknown>): string {
	if (r.status === "fulfilled") return "unparseable response";
	return r.reason instanceof Error ? r.reason.message : String(r.reason);
}

export async function getRunbookForAlert(
	proxy: AtlassianMcpProxy,
	ctx: GetRunbookContext,
): Promise<GetRunbookForAlertOutput> {
	const args = { service: ctx.service, errorKeywords: ctx.errorKeywords, spaceKey: ctx.spaceKey };
	const cql = buildRunbookCql(args);
	const errorCql = buildErrorCql(args);

	log.info({ service: ctx.service, cql, errorCql }, "Searching for runbooks");

	// The two halves fail independently (the SIO-1802 lesson): one throwing must not discard the other.
	const [runbookResult, errorResult] = await Promise.allSettled([
		searchPages(proxy, cql),
		errorCql ? searchPages(proxy, errorCql) : Promise.resolve(null),
	]);
	const runbookHits = runbookResult.status === "fulfilled" ? runbookResult.value : null;
	const errorHits = errorResult.status === "fulfilled" ? errorResult.value : null;
	if (!runbookHits && !errorHits) {
		if (runbookResult.status === "rejected") throw runbookResult.reason;
		if (errorResult.status === "rejected") throw errorResult.reason;
		return { service: ctx.service, cql, ...(errorCql ? { errorCql } : {}), matches: [] };
	}
	const warnings: string[] = [];
	if (!runbookHits) {
		log.warn({ service: ctx.service, reason: describeFailure(runbookResult) }, "Runbook query failed");
		warnings.push(
			`The search for runbook-like pages about ${ctx.service} failed; only pages citing the error are listed.`,
		);
	}
	if (errorCql && !errorHits) {
		log.warn({ service: ctx.service, reason: describeFailure(errorResult) }, "Error-keyword query failed");
		warnings.push("The search for pages citing the error keywords failed; only runbook-like pages are listed.");
	}

	const seen = new Set<string>();
	const pool: ConfluenceSearchResult[] = [];
	const add = (hits: ConfluenceSearchResult[] | null) => {
		for (const hit of hits ?? []) {
			const key = hit.content?.id ?? hit.url ?? hit.title ?? "";
			if (seen.has(key)) continue;
			seen.add(key);
			pool.push(hit);
		}
	};
	add(runbookHits);
	add(errorHits);

	let fallbackCql: string | undefined;
	if (pool.length < ctx.limit) {
		fallbackCql = buildCql(args);
		try {
			add(await searchPages(proxy, fallbackCql));
		} catch (error) {
			// The focused queries already produced a usable answer; the fallback is best effort.
			log.warn(
				{ service: ctx.service, reason: error instanceof Error ? error.message : String(error) },
				"Fallback query failed",
			);
		}
	}

	// Array.prototype.sort is stable, so ties keep retrieval order: runbook-like, error, fallback.
	const matches = pool
		.map((raw) => shapePage(raw, ctx.siteUrl))
		.map((page) => ({ ...page, relevanceScore: scorePage(page, ctx.service, ctx.errorKeywords) }))
		.sort((a, b) => b.relevanceScore - a.relevanceScore)
		.slice(0, ctx.limit);

	return {
		service: ctx.service,
		cql,
		...(errorCql ? { errorCql } : {}),
		...(fallbackCql ? { fallbackCql } : {}),
		matches,
		...(warnings.length > 0 ? { warnings } : {}),
	};
}

export function registerGetRunbookForAlert(server: McpServer, proxy: AtlassianMcpProxy, siteUrl?: string): void {
	server.registerTool(
		"getRunbookForAlert",
		{
			description:
				"Search Confluence for runbooks relevant to a service alert. Returns pages ranked by relevance score.",
			inputSchema: {
				service: z.string().describe("Service name to find runbooks for"),
				errorKeywords: errorKeywordsField.describe("Error keywords to include in the search"),
				spaceKey: z.string().optional().describe("Confluence space key to scope the search"),
				limit: z.number().int().positive().default(5).describe("Maximum number of runbook pages to return"),
			},
			annotations: CUSTOM_READ_ONLY_ANNOTATIONS,
		},
		async (args) => {
			return traceToolCall("getRunbookForAlert", async () => {
				try {
					const output = await getRunbookForAlert(proxy, {
						service: args.service,
						errorKeywords: args.errorKeywords ?? [],
						spaceKey: args.spaceKey,
						limit: args.limit ?? 5,
						siteUrl,
					});
					return { content: [{ type: "text" as const, text: JSON.stringify(output, null, 2) }] };
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					log.error({ error: message }, "getRunbookForAlert tool failed");
					// SIO-1183: envelope the failure (auth-expired / upstream-status kinds) instead of
					// raw prose the agent classifies as "unknown".
					return toolErrorResult(error);
				}
			});
		},
	);
}

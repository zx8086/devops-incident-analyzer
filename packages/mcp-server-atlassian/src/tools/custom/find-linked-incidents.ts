// src/tools/custom/find-linked-incidents.ts

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AtlassianMcpProxy } from "../../atlassian-client/index.js";
import { createContextLogger } from "../../utils/logger.js";
import { traceToolCall } from "../../utils/tracing.js";
import { CUSTOM_READ_ONLY_ANNOTATIONS } from "../annotations.js";
import { toolErrorResult } from "../error-envelope.js";
import { parseAtlassianTextContent } from "./parse-atlassian-content.js";
import { resolveEffectiveProjects } from "./validate-incident-projects.js";

const log = createContextLogger("find-linked-incidents");

function escapeJqlString(value: string): string {
	return value.replace(/[\\"]/g, "\\$&");
}

// SIO-1802: JQL `text ~ "a b"` is a stemmed BAG OF WORDS, not a phrase. Live, the keyword
// "styles scope" matched a ticket saying "Style" and "out of scope", and the run's 15
// results were all unrelated while the two exact prior incidents were never retrieved
// (results are capped by recency, so junk fills every slot). A phrase needs inner quotes.
// Same run, measured: 88 matches -> 36, and 0 -> 5 of the top 15 about the incident's own
// service. A single word stays unquoted so stemming (timeout/timeouts) still helps it.
// SIO-1806: the one rule for "is this keyword a phrase", shared with the Confluence CQL builder
// (measured there too: CQL `text ~ "a b"` is the same stemmed bag of words).
export function isPhraseKeyword(keyword: string): boolean {
	return /\s/.test(keyword);
}

function keywordTextClause(keyword: string): string {
	const escaped = escapeJqlString(keyword);
	return isPhraseKeyword(keyword) ? `text ~ "\\"${escaped}\\""` : `text ~ "${escaped}"`;
}

// SIO-1093 (CodeRabbit): bound domain-term input so a large/duplicated list can't blow up the JQL/CQL
// OR-clause count or query length. Trim, drop blanks, cap per-term length, dedupe, cap total count.
export const MAX_ERROR_KEYWORDS = 8;
export const MAX_ERROR_KEYWORD_LENGTH = 100;

export function sanitizeErrorKeywords(keywords: string[] | undefined): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const raw of keywords ?? []) {
		const term = raw.trim().slice(0, MAX_ERROR_KEYWORD_LENGTH);
		if (term.length === 0 || seen.has(term)) continue;
		seen.add(term);
		out.push(term);
		if (out.length >= MAX_ERROR_KEYWORDS) break;
	}
	return out;
}

// Shared Zod field so the tool registration schemas enforce the same bounds the sanitizer applies.
export const errorKeywordsField = z.array(z.string().max(MAX_ERROR_KEYWORD_LENGTH)).max(MAX_ERROR_KEYWORDS).default([]);

export const InputSchema = z.object({
	service: z.string().describe("Service name to search for in Jira incidents"),
	componentLabel: z.string().optional().describe("Optional Jira component or label to narrow results"),
	errorKeywords: errorKeywordsField.describe(
		"Incident domain terms to text-match (e.g. ['AFS season code', 'FMS', 'THE1']). Broadens the search beyond an exact service label so tickets that don't carry the service as a Jira label are still found.",
	),
	withinDays: z.number().int().positive().default(30).describe("How many days back to search (default 30)"),
	limit: z.number().int().positive().default(10).describe("Maximum number of issues to return"),
	incidentProjects: z
		.array(z.string())
		.default([])
		.describe(
			"Jira project keys to scope the search. Server-configured (from ATLASSIAN_INCIDENT_PROJECTS); when empty the search spans ALL visible projects. Not chosen by the caller -- do not assume a fixed set of incident projects.",
		),
	siteUrl: z
		.string()
		.optional()
		.describe("Atlassian site URL for building browse links (e.g. https://tommy.atlassian.net)"),
});

const ShapedIssueSchema = z.object({
	key: z.string(),
	summary: z.string(),
	status: z.string(),
	severity: z.string().nullable(),
	createdAt: z.string(),
	resolvedAt: z.string().nullable(),
	mttrMinutes: z.number().nullable(),
	url: z.string().optional(),
	matchedBy: z
		.array(z.string())
		.describe(
			"SIO-1802: which search clauses this ticket visibly satisfies -- service-label, service-text, component, keyword:<term>. Labels and components are exact; text clauses are checked against summary + description only, an approximation of JQL `text ~` (which also reads comments), so an empty list means 'matched somewhere this tool cannot see', not 'did not match'.",
		),
	score: z
		.number()
		.describe("SIO-1802: label/component hit 3, service named in the text 2, each keyword 1. Issues are sorted by it."),
});

export const OutputSchema = z.object({
	service: z.string(),
	jql: z.string(),
	keywordJql: z
		.string()
		.optional()
		.describe(
			"SIO-1802: the separate keyword query, present when errorKeywords were supplied. `jql` is the service query.",
		),
	count: z.number(),
	issues: z.array(ShapedIssueSchema),
	configWarning: z
		.string()
		.optional()
		.describe(
			"Set when ATLASSIAN_INCIDENT_PROJECTS named projects that do not exist on this site (SIO-1184) and/or when more incidents matched than were returned (SIO-1336). Multiple warnings are space-joined.",
		),
});

export type FindLinkedIncidentsInput = z.infer<typeof InputSchema>;
export type FindLinkedIncidentsOutput = z.infer<typeof OutputSchema>;

export interface FindLinkedIncidentsContext {
	service: string;
	componentLabel?: string;
	errorKeywords?: string[];
	withinDays: number;
	limit: number;
	incidentProjects: string[];
	siteUrl?: string;
}

export interface BuildJqlArgs {
	service: string;
	componentLabel: string | undefined;
	errorKeywords?: string[];
	withinDays: number;
	incidentProjects: string[];
	// SIO-1802: which clauses to OR together. "all" (default) is the SIO-1093 shape and what
	// get-incident-history uses; findLinkedIncidents asks for the two halves separately.
	match?: "all" | "service" | "keywords";
}

export interface JiraIssueRaw {
	key: string;
	fields: {
		summary: string;
		status: { name: string };
		priority?: { name: string } | null;
		customfield_severity?: { value: string } | null;
		created: string;
		resolutiondate?: string | null;
		// SIO-1802: the upstream returns these by default (no `fields` needed); they were
		// simply never read. description is a string only because the call asks for markdown.
		labels?: string[] | null;
		components?: Array<{ name?: string }> | null;
		description?: unknown;
	};
}

// SIO-1805: every field shapeIssue and attributeMatch read, requested EXPLICITLY. With
// `fields` omitted the upstream returns a default set that has `resolution` but NOT
// `resolutiondate` (checked live on resolved tickets: the key is absent), so resolvedAt and
// mttrMinutes were null for every ticket, resolved or not. An explicit list REPLACES that
// default, so anything read from `fields` must be named here; the test pins that.
// `customfield_severity` is deliberately not requested: no such field exists on the site
// (204 fields checked), so `priority` is the only severity signal the fallback ever sees.
export const LINKED_INCIDENT_FIELDS = [
	"summary",
	"status",
	"priority",
	"created",
	"resolutiondate",
	"labels",
	"components",
	"description",
] as const;

// What the JQL was built from, so each returned ticket can be attributed to a clause.
export interface MatchTerms {
	service: string;
	componentLabel?: string;
	errorKeywords?: string[];
}

const SCORE_STRUCTURAL = 3;
const SCORE_SERVICE_TEXT = 2;
const SCORE_KEYWORD = 1;

// SIO-1802 (Greptile, PR #831): Jira matches a phrase across whatever separates its words --
// a newline, `**bold**`, a double space -- so a literal substring test missed hits Jira had
// made ("kv\ntimeout", "**kv** timeout"), and a missed hit can drop a relevant ticket now
// that attribution filters. Compare word sequences instead: lowercase, every run of
// non-alphanumerics becomes one space, padded with a space at both ends so every word has
// a boundary on each side. Still an approximation of `text ~`, and documented as one.
function wordSequence(s: string): string {
	return ` ${s
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, " ")
		.trim()} `;
}

// Greptile, PR #831 round 2: a term anchored only at its START let service `api` hit
// `apiary`, and a false `service-text` is structural, so it walked past the weak-hit
// filter. A term now needs a boundary on BOTH sides; the only slack is a plural on its last
// word (`timeout` hits `timeouts`), the part of Jira's stemming worth having. wordSequence
// leaves only letters, digits and spaces, so the term needs no regex escaping.
function containsTerm(haystack: string, term: string): boolean {
	const words = wordSequence(term).trim();
	return words.length > 0 && new RegExp(` ${words}(?:s|es)? `, "u").test(haystack);
}

// SIO-1802: deterministic attribution, no second Jira call and no LLM. Mirrors the additive
// scoring of the sibling scorePage (get-runbook-for-alert.ts).
export function attributeMatch(raw: JiraIssueRaw, terms: MatchTerms): { matchedBy: string[]; score: number } {
	const { fields } = raw;
	const labels = (fields.labels ?? []).map((l) => l.toLowerCase());
	const components = (fields.components ?? []).map((c) => (c.name ?? "").toLowerCase());
	const description =
		typeof fields.description === "string" ? fields.description : JSON.stringify(fields.description ?? "");
	const text = wordSequence(`${fields.summary} ${description}`);
	const service = terms.service.trim().toLowerCase();
	const component = terms.componentLabel?.trim().toLowerCase();

	const matchedBy: string[] = [];
	let score = 0;
	if (service && labels.includes(service)) {
		matchedBy.push("service-label");
		score += SCORE_STRUCTURAL;
	}
	if (component && (components.includes(component) || labels.includes(component))) {
		matchedBy.push("component");
		score += SCORE_STRUCTURAL;
	}
	if (containsTerm(text, service)) {
		matchedBy.push("service-text");
		score += SCORE_SERVICE_TEXT;
	}
	for (const keyword of sanitizeErrorKeywords(terms.errorKeywords)) {
		if (!containsTerm(text, keyword)) continue;
		matchedBy.push(`keyword:${keyword}`);
		score += SCORE_KEYWORD;
	}
	return { matchedBy, score };
}

export function buildJql({
	service,
	componentLabel,
	errorKeywords,
	withinDays,
	incidentProjects,
	match = "all",
}: BuildJqlArgs): string {
	const parts: string[] = [];

	if (incidentProjects.length > 0) {
		parts.push(`project in (${incidentProjects.join(", ")})`);
	} else {
		parts.push("project is not EMPTY");
	}

	// SIO-1093: match by incident DOMAIN TERMS, not just an exact service label. Incident
	// tickets are frequently NOT tagged with the normalized service as a Jira label (the prana
	// AFS case: `labels = "order-service"` returned 0 while the tickets exist under AFS/FMS/season
	// text). Build an OR across the label, a free-text match on the service, and a free-text match
	// on each supplied error keyword so a ticket is found by any of them.
	const structuralClauses = [
		`labels = "${escapeJqlString(service)}"`,
		`text ~ "${escapeJqlString(service)}"`,
		...(componentLabel
			? [`component = "${escapeJqlString(componentLabel)}"`, `labels = "${escapeJqlString(componentLabel)}"`]
			: []),
	];
	const keywordClauses = sanitizeErrorKeywords(errorKeywords).map(keywordTextClause);
	const matchClauses =
		match === "service"
			? structuralClauses
			: match === "keywords" && keywordClauses.length > 0
				? keywordClauses
				: [...structuralClauses, ...keywordClauses];
	parts.push(`(${matchClauses.join(" OR ")})`);

	parts.push(`created >= -${withinDays}d`);

	return `${parts.join(" AND ")} ORDER BY created DESC`;
}

export function shapeIssue(raw: JiraIssueRaw, siteUrl?: string, terms?: MatchTerms): z.infer<typeof ShapedIssueSchema> {
	const { key, fields } = raw;
	const { matchedBy, score } = terms ? attributeMatch(raw, terms) : { matchedBy: [], score: 0 };

	const severity = fields.priority?.name ?? fields.customfield_severity?.value ?? null;

	const resolvedAt = fields.resolutiondate ?? null;
	const mttrMinutes = resolvedAt
		? (() => {
				const ms = new Date(resolvedAt).getTime() - new Date(fields.created).getTime();
				return Number.isFinite(ms) ? Math.round(ms / 60000) : null;
			})()
		: null;

	return {
		key,
		summary: fields.summary,
		status: fields.status.name,
		severity,
		createdAt: fields.created,
		resolvedAt,
		mttrMinutes,
		url: siteUrl ? `${siteUrl}/browse/${key}` : undefined,
		matchedBy,
		score,
	};
}

// SIO-704: tolerate the {issues, isLast, nextPageToken} pagination envelope and any
// future top-level fields the upstream may add. Extra keys are ignored at runtime.
// SIO-1336: isLast is read (see below) -- more matches exist beyond `limit` than the
// count:N this tool reports, and that must not be silently indistinguishable from
// "N is the total that matched."
interface JiraSearchResponse {
	issues?: JiraIssueRaw[];
	isLast?: boolean;
}

export async function findLinkedIncidents(
	proxy: AtlassianMcpProxy,
	ctx: FindLinkedIncidentsContext,
): Promise<FindLinkedIncidentsOutput> {
	// SIO-1802: the service clauses and the keyword clauses are searched SEPARATELY. In one
	// OR they compete for the same `limit` slots under `ORDER BY created DESC`, and a generic
	// single-word keyword wins that race every time: live, keywords `article`/`styles`/`kv`
	// matched 1,043 tickets in 90 days, today's junk filled all 10 slots, and the focus
	// service's own incidents never came back (the card then correctly dropped all 10 and
	// showed nothing). The service query alone returned exactly the 10 related tickets.
	const base = {
		service: ctx.service,
		componentLabel: ctx.componentLabel,
		errorKeywords: ctx.errorKeywords,
		withinDays: ctx.withinDays,
		incidentProjects: ctx.incidentProjects,
	};
	const jql = buildJql({ ...base, match: "service" });
	const keywordJql =
		sanitizeErrorKeywords(ctx.errorKeywords).length > 0 ? buildJql({ ...base, match: "keywords" }) : undefined;

	log.info({ service: ctx.service, jql, keywordJql }, "Searching for linked incidents");

	// Greptile, PR #832: the two halves must fail independently. With Promise.all a throwing
	// keyword query discarded good service hits, and an unparseable service response became a
	// silent keyword-only result. allSettled keeps whichever half worked and SAYS which did not.
	const [serviceResult, keywordResult] = await Promise.allSettled([
		searchIssues(proxy, jql, ctx.limit),
		keywordJql ? searchIssues(proxy, keywordJql, ctx.limit) : Promise.resolve(null),
	]);
	const serviceHits = serviceResult.status === "fulfilled" ? serviceResult.value : null;
	const keywordHits = keywordResult.status === "fulfilled" ? keywordResult.value : null;
	if (!serviceHits && !keywordHits) {
		// Nothing usable. A thrown service query stays loud (SIO-1116), as it was with one query.
		if (serviceResult.status === "rejected") throw serviceResult.reason;
		if (keywordResult.status === "rejected") throw keywordResult.reason;
		return { service: ctx.service, jql, count: 0, issues: [] };
	}
	const warnings: string[] = [];
	if (!serviceHits) {
		log.warn(
			{ service: ctx.service, reason: describeFailure(serviceResult) },
			"Service query failed; keyword hits only",
		);
		warnings.push(
			`The search for tickets naming ${ctx.service} failed; the results below come from the keyword search only and may miss that service's own incidents.`,
		);
	}
	if (keywordJql && !keywordHits) {
		log.warn(
			{ service: ctx.service, reason: describeFailure(keywordResult) },
			"Keyword query failed; service hits only",
		);
		warnings.push("The keyword search failed; the results below are tickets naming the service only.");
	}

	const terms: MatchTerms = {
		service: ctx.service,
		componentLabel: ctx.componentLabel,
		errorKeywords: ctx.errorKeywords,
	};
	const byScore = (a: { score: number }, b: { score: number }) => b.score - a.score;
	// A ticket the SERVICE query returned matched a service clause by construction. When
	// attribution cannot see where (a comment, a field this tool does not read), say so rather
	// than score it 0: otherwise it sinks below every keyword hit and the extractor drops it.
	const serviceIssues = (serviceHits?.issues ?? [])
		.map((raw) => {
			const shaped = shapeIssue(raw, ctx.siteUrl, terms);
			if (shaped.matchedBy.some((m) => !m.startsWith("keyword:"))) return shaped;
			return { ...shaped, matchedBy: ["service-text", ...shaped.matchedBy], score: shaped.score + SCORE_SERVICE_TEXT };
		})
		.sort(byScore);
	const serviceKeys = new Set(serviceIssues.map((i) => i.key));
	const keywordIssues = (keywordHits?.issues ?? [])
		.filter((raw) => !serviceKeys.has(raw.key))
		.map((raw) => shapeIssue(raw, ctx.siteUrl, terms))
		.sort(byScore);
	// Greptile, PR #832: one global score sort let a ticket with three generic keywords (3)
	// outrank a real service hit (2) and push it past `limit`. Service hits are ranked among
	// themselves and ALWAYS come first; keyword-only hits fill what is left.
	const issues = [...serviceIssues, ...keywordIssues].slice(0, ctx.limit);

	// SIO-1336: isLast:false means more matches exist beyond this page than `count` reports --
	// without this, count reads as the total that matched (it is only the total returned).
	if (serviceHits?.isLast === false || keywordHits?.isLast === false) {
		warnings.push(
			`More than ${issues.length} incidents matched within ${ctx.withinDays}d; results were truncated to the requested limit. Increase limit or narrow withinDays to see the full set.`,
		);
	}

	return {
		service: ctx.service,
		jql,
		...(keywordJql ? { keywordJql } : {}),
		count: issues.length,
		issues,
		...(warnings.length > 0 ? { configWarning: warnings.join(" ") } : {}),
	};
}

function describeFailure(result: PromiseSettledResult<unknown>): string {
	if (result.status === "fulfilled") return "unparseable response";
	return result.reason instanceof Error ? result.reason.message : String(result.reason);
}

async function searchIssues(
	proxy: AtlassianMcpProxy,
	jql: string,
	maxResults: number,
): Promise<JiraSearchResponse | null> {
	const result = await proxy.callTool("searchJiraIssuesUsingJql", {
		jql,
		maxResults,
		// SIO-1116: the Rovo upstream now REQUIRES searchResultMode (values "issues" | "count"
		// | "all", listed in its `required` array despite a documented default of "issues").
		// Omitting it made the upstream reject with -32602, which parseAtlassianTextContent
		// could not JSON-parse -> null -> a silent count:0. "issues" returns the issues array
		// this tool reads; "count" would return no issues and break it.
		searchResultMode: "issues",
		// SIO-1802: description as plain text so attributeMatch can look for the keywords
		// in it. It is read for attribution only and never returned, so the result stays small.
		responseContentFormat: "markdown",
		fields: [...LINKED_INCIDENT_FIELDS],
	});

	return parseAtlassianTextContent<JiraSearchResponse>(result as { content?: unknown }, {
		upstreamTool: "searchJiraIssuesUsingJql",
		context: { jql },
		log,
	});
}

export function registerFindLinkedIncidents(
	server: McpServer,
	proxy: AtlassianMcpProxy,
	incidentProjects: string[],
	siteUrl?: string,
): void {
	server.registerTool(
		"findLinkedIncidents",
		{
			description:
				"Find Jira incidents linked to a service within a time window. Returns shaped issues with severity, status, and MTTR.",
			inputSchema: {
				service: z.string().describe("Service name to search for in Jira incidents"),
				componentLabel: z.string().optional().describe("Optional Jira component or label to narrow results"),
				errorKeywords: errorKeywordsField.describe(
					"Incident domain terms to text-match (e.g. ['AFS season code', 'FMS', 'THE1']) so tickets not labelled with the service are still found.",
				),
				withinDays: z.number().int().positive().default(30).describe("How many days back to search"),
				limit: z.number().int().positive().default(10).describe("Maximum number of issues to return"),
			},
			outputSchema: OutputSchema.shape,
			annotations: CUSTOM_READ_ONLY_ANNOTATIONS,
		},
		async (args) => {
			return traceToolCall("findLinkedIncidents", async () => {
				try {
					// SIO-1184: drop configured project keys that do not exist on the site (INC,OPS shipped
					// dead for months); when none remain the empty list IS the all-projects wildcard.
					const effective = await resolveEffectiveProjects(proxy, incidentProjects);
					const output = await findLinkedIncidents(proxy, {
						service: args.service,
						componentLabel: args.componentLabel,
						errorKeywords: args.errorKeywords ?? [],
						withinDays: args.withinDays ?? 30,
						limit: args.limit ?? 10,
						incidentProjects: effective.projects,
						siteUrl,
					});
					// SIO-1336: compose rather than overwrite -- a nonexistent-project warning and a
					// pagination-truncation warning can both be true for the same call.
					const warnings = [effective.configWarning, output.configWarning].filter((w): w is string => w !== undefined);
					const payload: FindLinkedIncidentsOutput =
						warnings.length > 0 ? { ...output, configWarning: warnings.join(" ") } : output;
					return {
						content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
						structuredContent: payload,
					};
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					log.error({ error: message }, "findLinkedIncidents tool failed");
					// SIO-1183: envelope the failure (auth-expired / upstream-status kinds) instead of
					// raw prose the agent classifies as "unknown".
					return toolErrorResult(error);
				}
			});
		},
	);
}

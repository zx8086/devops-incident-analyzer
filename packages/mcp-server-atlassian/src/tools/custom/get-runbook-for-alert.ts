// src/tools/custom/get-runbook-for-alert.ts

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AtlassianMcpProxy } from "../../atlassian-client/index.js";
import { createContextLogger } from "../../utils/logger.js";
import { traceToolCall } from "../../utils/tracing.js";
import { parseAtlassianTextContent } from "./parse-atlassian-content.js";

const log = createContextLogger("get-runbook-for-alert");

function escapeCqlString(value: string): string {
	return value.replace(/[\\"]/g, "\\$&");
}

const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1_000;

export const InputSchema = z.object({
	service: z.string().describe("Service name to find runbooks for"),
	errorKeywords: z.array(z.string()).default([]).describe("Error keywords to include in the search"),
	spaceKey: z.string().optional().describe("Confluence space key to scope the search"),
	limit: z.number().int().positive().default(5).describe("Maximum number of runbook pages to return"),
	siteUrl: z.string().optional().describe("Atlassian Confluence base URL for building page links"),
});

export const ConfluencePageSchema = z.object({
	id: z.string(),
	title: z.string(),
	spaceKey: z.string(),
	labels: z.array(z.string()),
	lastUpdated: z.string(),
	excerpt: z.string(),
});

export const MatchedPageSchema = ConfluencePageSchema.extend({
	relevanceScore: z.number(),
	url: z.string().optional(),
});

export const OutputSchema = z.object({
	service: z.string(),
	cql: z.string(),
	matches: z.array(MatchedPageSchema),
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

export function buildCql({ service, errorKeywords, spaceKey }: BuildCqlArgs): string {
	const textTerms = [service, ...errorKeywords].map((t) => `text ~ "${escapeCqlString(t)}"`);
	const parts: string[] = [`(${textTerms.join(" OR ")})`];

	if (spaceKey) {
		parts.push(`space = "${escapeCqlString(spaceKey)}"`);
	}

	return `${parts.join(" AND ")} ORDER BY lastModified DESC`;
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

	const labelNames = page.labels.map((l) => l.toLowerCase());
	if (labelNames.includes("runbook")) score += 2;

	const ageMs = Date.now() - new Date(page.lastUpdated).getTime();
	if (ageMs < NINETY_DAYS_MS) score += 1;

	return score;
}

// SIO-704: tolerate the {issues, isLast, nextPageToken} pagination envelope and any
// future top-level fields the upstream may add. Extra keys are ignored at runtime.
interface ConfluenceSearchResponse {
	results?: ConfluencePage[];
}

export async function getRunbookForAlert(
	proxy: AtlassianMcpProxy,
	ctx: GetRunbookContext,
): Promise<GetRunbookForAlertOutput> {
	const cql = buildCql({
		service: ctx.service,
		errorKeywords: ctx.errorKeywords,
		spaceKey: ctx.spaceKey,
	});

	log.info({ service: ctx.service, cql }, "Searching for runbooks");

	const result = await proxy.callTool("searchConfluencePages", { cql });

	const parsed = parseAtlassianTextContent<ConfluenceSearchResponse>(result as { content?: unknown }, {
		upstreamTool: "searchConfluencePages",
		context: { cql },
		log,
	});
	if (!parsed) {
		return { service: ctx.service, cql, matches: [] };
	}

	const pages = parsed.results ?? [];

	const scored = pages
		.map((page) => ({
			...page,
			relevanceScore: scorePage(page, ctx.service, ctx.errorKeywords),
			url: ctx.siteUrl ? `${ctx.siteUrl}/wiki/spaces/${page.spaceKey}/pages/${page.id}` : undefined,
		}))
		.sort((a, b) => b.relevanceScore - a.relevanceScore)
		.slice(0, ctx.limit);

	return { service: ctx.service, cql, matches: scored };
}

export function registerGetRunbookForAlert(server: McpServer, proxy: AtlassianMcpProxy, siteUrl?: string): void {
	server.tool(
		"getRunbookForAlert",
		"Search Confluence for runbooks relevant to a service alert. Returns pages ranked by relevance score.",
		{
			service: z.string().describe("Service name to find runbooks for"),
			errorKeywords: z.array(z.string()).default([]).describe("Error keywords to include in the search"),
			spaceKey: z.string().optional().describe("Confluence space key to scope the search"),
			limit: z.number().int().positive().default(5).describe("Maximum number of runbook pages to return"),
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
					return { content: [{ type: "text" as const, text: `Error: ${message}` }], isError: true };
				}
			});
		},
	);
}

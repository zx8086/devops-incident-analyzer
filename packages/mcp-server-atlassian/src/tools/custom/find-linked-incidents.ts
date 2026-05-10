// src/tools/custom/find-linked-incidents.ts

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AtlassianMcpProxy } from "../../atlassian-client/index.js";
import { createContextLogger } from "../../utils/logger.js";
import { traceToolCall } from "../../utils/tracing.js";
import { parseAtlassianTextContent } from "./parse-atlassian-content.js";

const log = createContextLogger("find-linked-incidents");

function escapeJqlString(value: string): string {
	return value.replace(/[\\"]/g, "\\$&");
}

export const InputSchema = z.object({
	service: z.string().describe("Service name to search for in Jira incidents"),
	componentLabel: z.string().optional().describe("Optional Jira component or label to narrow results"),
	withinDays: z.number().int().positive().default(30).describe("How many days back to search (default 30)"),
	limit: z.number().int().positive().default(10).describe("Maximum number of issues to return"),
	incidentProjects: z
		.array(z.string())
		.default([])
		.describe("Jira project keys to scope the search (e.g. ['INC', 'OPS'])"),
	siteUrl: z
		.string()
		.optional()
		.describe("Atlassian site URL for building browse links (e.g. https://tommy.atlassian.net)"),
});

export const ShapedIssueSchema = z.object({
	key: z.string(),
	summary: z.string(),
	status: z.string(),
	severity: z.string().nullable(),
	createdAt: z.string(),
	resolvedAt: z.string().nullable(),
	mttrMinutes: z.number().nullable(),
	url: z.string().optional(),
});

export const OutputSchema = z.object({
	service: z.string(),
	jql: z.string(),
	count: z.number(),
	issues: z.array(ShapedIssueSchema),
});

export type FindLinkedIncidentsInput = z.infer<typeof InputSchema>;
export type FindLinkedIncidentsOutput = z.infer<typeof OutputSchema>;

export interface FindLinkedIncidentsContext {
	service: string;
	componentLabel?: string;
	withinDays: number;
	limit: number;
	incidentProjects: string[];
	siteUrl?: string;
}

export interface BuildJqlArgs {
	service: string;
	componentLabel: string | undefined;
	withinDays: number;
	incidentProjects: string[];
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
	};
}

export function buildJql({ service, componentLabel, withinDays, incidentProjects }: BuildJqlArgs): string {
	const parts: string[] = [];

	if (incidentProjects.length > 0) {
		parts.push(`project in (${incidentProjects.join(", ")})`);
	} else {
		parts.push("project is not EMPTY");
	}

	if (componentLabel) {
		parts.push(
			`(labels = "${escapeJqlString(componentLabel)}" OR component = "${escapeJqlString(componentLabel)}" OR text ~ "${escapeJqlString(service)}")`,
		);
	} else {
		parts.push(`labels = "${escapeJqlString(service)}"`);
	}

	parts.push(`created >= -${withinDays}d`);

	return `${parts.join(" AND ")} ORDER BY created DESC`;
}

export function shapeIssue(raw: JiraIssueRaw, siteUrl?: string): z.infer<typeof ShapedIssueSchema> {
	const { key, fields } = raw;

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
	};
}

// SIO-704: tolerate the {issues, isLast, nextPageToken} pagination envelope and any
// future top-level fields the upstream may add. Extra keys are ignored at runtime.
interface JiraSearchResponse {
	issues?: JiraIssueRaw[];
}

export async function findLinkedIncidents(
	proxy: AtlassianMcpProxy,
	ctx: FindLinkedIncidentsContext,
): Promise<FindLinkedIncidentsOutput> {
	const jql = buildJql({
		service: ctx.service,
		componentLabel: ctx.componentLabel,
		withinDays: ctx.withinDays,
		incidentProjects: ctx.incidentProjects,
	});

	log.info({ service: ctx.service, jql }, "Searching for linked incidents");

	const result = await proxy.callTool("searchJiraIssuesUsingJql", {
		jql,
		maxResults: ctx.limit,
	});

	const parsed = parseAtlassianTextContent<JiraSearchResponse>(result as { content?: unknown }, {
		upstreamTool: "searchJiraIssuesUsingJql",
		context: { jql },
		log,
	});
	if (!parsed) {
		return { service: ctx.service, jql, count: 0, issues: [] };
	}

	const rawIssues = parsed.issues ?? [];
	const issues = rawIssues.map((raw) => shapeIssue(raw, ctx.siteUrl));

	return { service: ctx.service, jql, count: issues.length, issues };
}

export function registerFindLinkedIncidents(
	server: McpServer,
	proxy: AtlassianMcpProxy,
	incidentProjects: string[],
	siteUrl?: string,
): void {
	server.tool(
		"findLinkedIncidents",
		"Find Jira incidents linked to a service within a time window. Returns shaped issues with severity, status, and MTTR.",
		{
			service: z.string().describe("Service name to search for in Jira incidents"),
			componentLabel: z.string().optional().describe("Optional Jira component or label to narrow results"),
			withinDays: z.number().int().positive().default(30).describe("How many days back to search"),
			limit: z.number().int().positive().default(10).describe("Maximum number of issues to return"),
		},
		async (args) => {
			return traceToolCall("findLinkedIncidents", async () => {
				try {
					const output = await findLinkedIncidents(proxy, {
						service: args.service,
						componentLabel: args.componentLabel,
						withinDays: args.withinDays ?? 30,
						limit: args.limit ?? 10,
						incidentProjects,
						siteUrl,
					});
					return { content: [{ type: "text" as const, text: JSON.stringify(output, null, 2) }] };
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					log.error({ error: message }, "findLinkedIncidents tool failed");
					return { content: [{ type: "text" as const, text: `Error: ${message}` }], isError: true };
				}
			});
		},
	);
}

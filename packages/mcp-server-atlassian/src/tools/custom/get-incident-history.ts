// src/tools/custom/get-incident-history.ts

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AtlassianMcpProxy } from "../../atlassian-client/index.js";
import { createContextLogger } from "../../utils/logger.js";
import { traceToolCall } from "../../utils/tracing.js";
import { buildJql } from "./find-linked-incidents.js";
import { parseAtlassianTextContent } from "./parse-atlassian-content.js";

const log = createContextLogger("get-incident-history");

export const InputSchema = z.object({
	service: z.string().describe("Service name to aggregate incident history for"),
	windowDays: z.number().int().positive().default(30).describe("Number of days to look back"),
	groupBy: z.enum(["week", "month"]).default("week").describe("Time bucket granularity"),
	incidentProjects: z.array(z.string()).default([]).describe("Jira project keys to scope the search"),
});

export const BucketSchema = z.object({
	bucketKey: z.string().describe("ISO date string for the bucket start (YYYY-MM-DD)"),
	incidentCount: z.number(),
	unresolvedCount: z.number(),
	mttrMinutes: z.number().nullable().describe("Mean MTTR for resolved incidents in this bucket, null if none resolved"),
});

export const TotalsSchema = z.object({
	incidentCount: z.number(),
	unresolvedCount: z.number(),
	mttrMinutes: z.number().nullable().describe("Overall mean MTTR for resolved incidents, null if none resolved"),
});

export const OutputSchema = z.object({
	service: z.string(),
	windowDays: z.number(),
	groupBy: z.enum(["week", "month"]),
	totals: TotalsSchema,
	buckets: z.array(BucketSchema),
});

export type GetIncidentHistoryInput = z.infer<typeof InputSchema>;
export type GetIncidentHistoryOutput = z.infer<typeof OutputSchema>;

export interface GetIncidentHistoryContext {
	service: string;
	windowDays: number;
	groupBy: "week" | "month";
	incidentProjects: string[];
}

interface RawIssueForHistory {
	fields: {
		created: string;
		resolutiondate: string | null | undefined;
	};
}

export function bucketKey(date: Date, groupBy: "week" | "month"): string {
	if (groupBy === "month") {
		const year = date.getUTCFullYear();
		const month = String(date.getUTCMonth() + 1).padStart(2, "0");
		return `${year}-${month}-01`;
	}

	// ISO week: find Monday of the week
	const dayOfWeek = date.getUTCDay(); // 0 = Sunday, 1 = Monday, ...
	// Days since Monday: Sunday is 6 days after Monday (mod 7)
	const daysSinceMonday = (dayOfWeek + 6) % 7;
	const monday = new Date(date);
	monday.setUTCDate(date.getUTCDate() - daysSinceMonday);

	const year = monday.getUTCFullYear();
	const month = String(monday.getUTCMonth() + 1).padStart(2, "0");
	const day = String(monday.getUTCDate()).padStart(2, "0");
	return `${year}-${month}-${day}`;
}

export function aggregate(
	issues: RawIssueForHistory[],
	windowDays: number,
	groupBy: "week" | "month",
	service: string,
): GetIncidentHistoryOutput {
	interface BucketAccum {
		incidentCount: number;
		unresolvedCount: number;
		totalMttrMs: number;
		resolvedCount: number;
	}

	const bucketMap = new Map<string, BucketAccum>();

	let totalMttrMs = 0;
	let totalResolved = 0;
	let totalUnresolved = 0;

	for (const issue of issues) {
		const created = new Date(issue.fields.created);
		const key = bucketKey(created, groupBy);

		if (!bucketMap.has(key)) {
			bucketMap.set(key, { incidentCount: 0, unresolvedCount: 0, totalMttrMs: 0, resolvedCount: 0 });
		}
		// biome-ignore lint/style/noNonNullAssertion: guaranteed by has check above
		const bucket = bucketMap.get(key)!;
		bucket.incidentCount++;

		if (issue.fields.resolutiondate) {
			const createdMs = created.getTime();
			const resolvedMs = new Date(issue.fields.resolutiondate).getTime();
			if (Number.isFinite(createdMs) && Number.isFinite(resolvedMs)) {
				const mttrMs = resolvedMs - createdMs;
				bucket.totalMttrMs += mttrMs;
				bucket.resolvedCount++;
				totalMttrMs += mttrMs;
				totalResolved++;
			}
		} else {
			bucket.unresolvedCount++;
			totalUnresolved++;
		}
	}

	const buckets = Array.from(bucketMap.entries())
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([key, b]) => ({
			bucketKey: key,
			incidentCount: b.incidentCount,
			unresolvedCount: b.unresolvedCount,
			mttrMinutes: b.resolvedCount > 0 ? Math.round(b.totalMttrMs / b.resolvedCount / 60_000) : null,
		}));

	const totals: GetIncidentHistoryOutput["totals"] = {
		incidentCount: issues.length,
		unresolvedCount: totalUnresolved,
		mttrMinutes: totalResolved > 0 ? Math.round(totalMttrMs / totalResolved / 60_000) : null,
	};

	return { service, windowDays, groupBy, totals, buckets };
}

// SIO-704: tolerate the {issues, isLast, nextPageToken} pagination envelope and any
// future top-level fields the upstream may add. Extra keys are ignored at runtime.
interface JiraSearchResponse {
	issues?: RawIssueForHistory[];
}

export async function getIncidentHistory(
	proxy: AtlassianMcpProxy,
	ctx: GetIncidentHistoryContext,
): Promise<GetIncidentHistoryOutput> {
	const jql = buildJql({
		service: ctx.service,
		componentLabel: undefined,
		withinDays: ctx.windowDays,
		incidentProjects: ctx.incidentProjects,
	});

	log.info({ service: ctx.service, jql, groupBy: ctx.groupBy }, "Fetching incident history");

	const result = await proxy.callTool("searchJiraIssuesUsingJql", {
		jql,
		maxResults: 1000,
	});

	const parsed = parseAtlassianTextContent<JiraSearchResponse>(result as { content?: unknown }, {
		upstreamTool: "searchJiraIssuesUsingJql",
		context: { jql },
		log,
	});
	if (!parsed) {
		return aggregate([], ctx.windowDays, ctx.groupBy, ctx.service);
	}

	return aggregate(parsed.issues ?? [], ctx.windowDays, ctx.groupBy, ctx.service);
}

export function registerGetIncidentHistory(
	server: McpServer,
	proxy: AtlassianMcpProxy,
	incidentProjects: string[],
): void {
	server.tool(
		"getIncidentHistory",
		"Aggregate Jira incident history for a service into time buckets. Returns per-bucket counts, MTTR, and totals.",
		{
			service: z.string().describe("Service name to aggregate incident history for"),
			windowDays: z.number().int().positive().default(30).describe("Number of days to look back"),
			groupBy: z.enum(["week", "month"]).default("week").describe("Time bucket granularity"),
		},
		async (args) => {
			return traceToolCall("getIncidentHistory", async () => {
				try {
					const output = await getIncidentHistory(proxy, {
						service: args.service,
						windowDays: args.windowDays ?? 30,
						groupBy: args.groupBy ?? "week",
						incidentProjects,
					});
					return { content: [{ type: "text" as const, text: JSON.stringify(output, null, 2) }] };
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					log.error({ error: message }, "getIncidentHistory tool failed");
					return { content: [{ type: "text" as const, text: `Error: ${message}` }], isError: true };
				}
			});
		},
	);
}

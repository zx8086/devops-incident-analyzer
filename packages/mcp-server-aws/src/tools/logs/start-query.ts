// src/tools/logs/start-query.ts
import { DescribeLogGroupsCommand, StartQueryCommand } from "@aws-sdk/client-cloudwatch-logs";
import { z } from "zod";
import type { AwsConfig } from "../../config/schemas.ts";
import { getCloudWatchLogsClient } from "../../services/client-factory.ts";
import { logger } from "../../utils/logger.ts";
import type { WithEstate } from "../estate-schema.ts";
import type { ToolError } from "../types.ts";
import { wrapBlobTool } from "../wrap.ts";

export const startQueryObjectSchema = z.object({
	logGroupNames: z
		.array(z.string())
		.min(1)
		.optional()
		.describe("Names of log groups to query (1+). Mutually exclusive with logGroupIdentifiers."),
	logGroupIdentifiers: z
		.array(z.string())
		.min(1)
		.optional()
		.describe("ARNs of log groups to query, including cross-account. Mutually exclusive with logGroupNames."),
	queryString: z.string().min(1).describe("CloudWatch Logs Insights query string"),
	startTime: z
		.number()
		.int()
		.describe(
			"Query window start (Unix epoch seconds). Only data within a log group's retention window is queryable; a startTime older than max(creationTime, now - retentionInDays) is auto-clamped, and a window ending before that floor is skipped rather than sent to CloudWatch.",
		),
	endTime: z.number().int().describe("Query window end (Unix epoch seconds)"),
	limit: z.number().int().min(1).max(10000).optional().describe("Max rows to return (1-10000)"),
});

// SIO-1078: minimal structural view of a log group -- only the fields the retention
// math reads, so the helpers stay decoupled from the SDK's full LogGroup type.
export interface LogGroupRetention {
	retentionInDays?: number;
	// SDK reports creationTime in epoch MILLISECONDS.
	creationTime?: number;
}

// Earliest queryable instant (epoch seconds) across the targeted groups. Per group the
// floor is max(creationTime, now - retentionInDays); missing retentionInDays = never-expire
// (unbounded below). A query spanning several groups can only reach as far back as the
// MOST-restrictive group, so the effective floor is the max of per-group floors. Returns
// NEGATIVE_INFINITY when nothing constrains the window (no groups, or all unbounded and
// without a known creationTime).
export function resolveQueryFloor(groups: LogGroupRetention[], nowSeconds: number): number {
	let floor = Number.NEGATIVE_INFINITY;
	for (const g of groups) {
		const retentionFloor =
			typeof g.retentionInDays === "number" ? nowSeconds - g.retentionInDays * 86_400 : Number.NEGATIVE_INFINITY;
		const creationFloor =
			typeof g.creationTime === "number" ? Math.floor(g.creationTime / 1000) : Number.NEGATIVE_INFINITY;
		const perGroup = Math.max(retentionFloor, creationFloor);
		floor = Math.max(floor, perGroup);
	}
	return floor;
}

export type QueryWindowDecision = { action: "pass" | "clamp" | "reject"; startTime: number };

// Decide how a requested [startTime, endTime] window relates to the retention floor:
// - reject: endTime < floor (the whole window predates retention -- CloudWatch would 400).
// - clamp:  startTime < floor <= endTime (salvage the retained slice).
// - pass:   startTime >= floor (unchanged).
export function decideQueryWindow(startTime: number, endTime: number, floor: number): QueryWindowDecision {
	if (endTime < floor) return { action: "reject", startTime };
	if (startTime < floor) return { action: "clamp", startTime: floor };
	return { action: "pass", startTime };
}

// SIO-1080: the AWS sub-agent LLM shifts the incident year back (e.g. 2026 -> 2025) because its
// training prior mis-dates "now", producing a window entirely outside retention and repeated
// MalformedQueryException. This deterministic guard cannot be overridden by the model: when the
// requested window ends before the retention floor BUT shifting it forward by whole CALENDAR years
// lands it inside [floor, now], the year was almost certainly shifted -- snap forward by the
// minimal number of years that fixes it. It never touches an already-valid window (endTime >= floor)
// and never produces a future-dated window (shifted startTime must stay <= now). A genuinely-old
// window that no shift can fix is returned unchanged so the existing reject path handles it.
// Calendar-year shifting via setUTCFullYear keeps leap-year dates correct (Feb-29 clamps sanely).
const MAX_YEAR_SHIFT = 5;

function shiftYears(epochSeconds: number, years: number): number {
	const d = new Date(epochSeconds * 1000);
	d.setUTCFullYear(d.getUTCFullYear() + years);
	return Math.floor(d.getTime() / 1000);
}

export function correctYearDrift(
	startTime: number,
	endTime: number,
	floor: number,
	nowSeconds: number,
): { startTime: number; endTime: number; shiftedYears: number } {
	// Only meaningful when a real floor is known and the window is actually out of range.
	if (!Number.isFinite(floor) || endTime >= floor) {
		return { startTime, endTime, shiftedYears: 0 };
	}
	for (let years = 1; years <= MAX_YEAR_SHIFT; years++) {
		const shiftedStart = shiftYears(startTime, years);
		const shiftedEnd = shiftYears(endTime, years);
		// Accept the smallest shift that brings the window into [floor, now]: end must reach the
		// retained slice, and start must not run past "now" (never fabricate a future window).
		if (shiftedEnd >= floor && shiftedStart <= nowSeconds) {
			return { startTime: shiftedStart, endTime: shiftedEnd, shiftedYears: years };
		}
	}
	return { startTime, endTime, shiftedYears: 0 };
}

export const startQuerySchema = startQueryObjectSchema.refine(
	(v) => (v.logGroupNames !== undefined) !== (v.logGroupIdentifiers !== undefined),
	"Provide exactly one of logGroupNames or logGroupIdentifiers",
);

export type StartQueryParams = WithEstate<z.infer<typeof startQueryObjectSchema>>;

// SIO-1078: thrown by the reject path so wrapBlobTool -> mapAwsError renders it as a
// bad-input _error carrying a retention-boundary advice string. Named
// "MalformedQueryException" so it maps identically to the raw CloudWatch rejection that
// the reactive wrap.ts backstop also handles -- one classification, two entry points.
class QueryWindowRejected extends Error {
	constructor(message: string) {
		super(message);
		this.name = "MalformedQueryException";
	}
}

// Resolve the retention floor for the targeted groups. Best-effort: any failure (IAM
// denied, throttled, group list races) returns null so the caller proceeds unclamped and
// the reactive wrap.ts advice becomes the backstop -- never worse than the pre-SIO-1078
// behavior. Returns null when there is nothing to describe.
async function fetchRetentionFloor(
	config: AwsConfig,
	params: StartQueryParams,
	nowSeconds: number,
): Promise<number | null> {
	const names = params.logGroupNames;
	const identifiers = params.logGroupIdentifiers;
	try {
		const client = getCloudWatchLogsClient(config, params.estate);
		// DescribeLogGroups matches by name prefix; identifiers (ARNs) aren't a prefix
		// filter, so for the ARN path we fetch and match by arn/logGroupName suffix.
		const collected: LogGroupRetention[] = [];
		const targets = names ?? identifiers ?? [];
		if (targets.length === 0) return null;
		for (const target of targets) {
			const prefix = names
				? target
				: (target
						.split(":")
						.pop()
						?.replace(/^log-group\//, "") ?? target);
			const res = await client.send(new DescribeLogGroupsCommand({ logGroupNamePrefix: prefix, limit: 50 }));
			for (const g of res.logGroups ?? []) {
				collected.push({ retentionInDays: g.retentionInDays, creationTime: g.creationTime });
			}
		}
		if (collected.length === 0) return null;
		return resolveQueryFloor(collected, nowSeconds);
	} catch {
		return null;
	}
}

export function startQuery(config: AwsConfig) {
	return wrapBlobTool({
		name: "aws_logs_start_query",
		fn: async (params: StartQueryParams) => {
			// SIO-1078: pre-flight retention check. Clamp a startTime that predates the
			// retained window, or short-circuit a window that ends before it -- so the
			// sub-agent stops looping StartQuery against logs that no longer exist (each
			// failure otherwise counts toward the aggregator tool-error confidence cap).
			const nowSeconds = Math.floor(Date.now() / 1000);
			const floor = await fetchRetentionFloor(config, params, nowSeconds);
			let effectiveStart = params.startTime;
			let effectiveEnd = params.endTime;
			if (floor !== null && Number.isFinite(floor)) {
				// SIO-1080: correct an LLM year-shift (e.g. 2026 incident queried as 2025) BEFORE
				// clamping. Deterministic; only fires when a forward year-shift lands the window in
				// range, and can move endTime too (clamp alone only adjusts startTime).
				const drift = correctYearDrift(effectiveStart, effectiveEnd, floor, nowSeconds);
				if (drift.shiftedYears > 0) {
					logger.warn(
						{
							tool: "aws_logs_start_query",
							shiftedYears: drift.shiftedYears,
							requestedStart: new Date(effectiveStart * 1000).toISOString(),
							correctedStart: new Date(drift.startTime * 1000).toISOString(),
						},
						"Corrected a year-shifted CloudWatch query window (likely LLM mis-dated the incident year)",
					);
					effectiveStart = drift.startTime;
					effectiveEnd = drift.endTime;
				}

				const decision = decideQueryWindow(effectiveStart, effectiveEnd, floor);
				if (decision.action === "reject") {
					const floorIso = new Date(floor * 1000).toISOString();
					// SIO-1079: the requested WINDOW is outside retention -- this does NOT mean the
					// incident's logs are gone. The window was likely mis-anchored (an incident is
					// almost always recent). Steer to re-anchoring, not to declaring the data absent.
					throw new QueryWindowRejected(
						`Skipped StartQuery: the requested time window ends before the earliest queryable time ` +
							`for these log groups (${floorIso}). The requested window -- not necessarily the incident -- ` +
							`is outside the retention window. Re-anchor startTime/endTime to the incident/event timestamp ` +
							`(which is usually recent) and retry; do not conclude the logs are expired unless the incident ` +
							`itself predates ${floorIso}.`,
					);
				}
				effectiveStart = decision.startTime;
			}
			const client = getCloudWatchLogsClient(config, params.estate);
			return client.send(
				new StartQueryCommand({
					logGroupNames: params.logGroupNames,
					logGroupIdentifiers: params.logGroupIdentifiers,
					queryString: params.queryString,
					startTime: effectiveStart,
					endTime: effectiveEnd,
					limit: params.limit,
				}),
			);
		},
	});
}

// Re-export for consumers that assert on the ToolError shape in tests.
export type { ToolError };

// src/tools/logs/start-query.ts
import { DescribeLogGroupsCommand, StartQueryCommand } from "@aws-sdk/client-cloudwatch-logs";
import { z } from "zod";
import type { AwsConfig } from "../../config/schemas.ts";
import { getCloudWatchLogsClient } from "../../services/client-factory.ts";
import { logger } from "../../utils/logger.ts";
import type { WithEstate } from "../estate-schema.ts";
import type { ToolError } from "../types.ts";
import { wrapBlobTool } from "../wrap.ts";

// SIO-1091: the window is RELATIVE by default. The LLM used to compute an absolute epoch and
// year-shift it (2026 -> 2025), landing outside retention; the whole year-drift/isReal/retention-
// floor harness existed only to defend that absolute-epoch path. A relative window ("now-30d")
// cannot drift, so the tool resolves the epoch itself and the harness is gone.
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
	queryString: z
		.string()
		.min(1)
		.describe(
			"CloudWatch Logs Insights query string. Commands are chained with `|`. Known-good example to find a service's errors: `fields @timestamp, @message | filter @message like /THE1/ | sort @timestamp desc | limit 20`. Use `filter @message like /regex/` for text matching. A MalformedQueryException about syntax/'unexpected symbol' is a SYNTAX error -- simplify to `fields @timestamp, @message | limit 20`.",
		),
	startRelative: z
		.string()
		.optional()
		.describe(
			'Query window start, RELATIVE to now (default "now-30d"). Wide by default. Format: "now" or "now-<n><unit>" where unit is s/m/h/d/w (e.g. "now-30d", "now-6h"). Prefer this over absolute epochs -- the server computes the epoch, so the year cannot be mis-dated.',
		),
	endRelative: z
		.string()
		.optional()
		.describe('Query window end, RELATIVE to now (default "now"). Same format as startRelative.'),
	startTime: z
		.number()
		.int()
		.optional()
		.describe(
			"Absolute query window start (Unix epoch SECONDS). Optional override for callers with an exact incident epoch; when omitted, startRelative is used. Do not compute this from a mis-dated year.",
		),
	endTime: z
		.number()
		.int()
		.optional()
		.describe("Absolute query window end (Unix epoch SECONDS). Optional override; when omitted, endRelative is used."),
	limit: z.number().int().min(1).max(10000).optional().describe("Max rows to return (1-10000)"),
});

// Minimal structural view of a log group -- only the fields the retention clamp reads.
export interface LogGroupRetention {
	retentionInDays?: number;
	// SDK reports creationTime in epoch MILLISECONDS.
	creationTime?: number;
}

// Earliest queryable instant (epoch seconds) across the targeted groups. Per group the floor is
// max(creationTime, now - retentionInDays); missing retentionInDays = never-expire (unbounded
// below). A query spanning several groups can only reach as far back as the MOST-restrictive group.
// Returns NEGATIVE_INFINITY when nothing constrains the window. Used only for a best-effort clamp of
// a relative start that predates retention -- never to reject or year-shift a window.
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

// SIO-1091: parse a relative window token ("now", "now-30d") into epoch SECONDS against nowSeconds.
// Units: s/m/h/d/w. Returns null for an unparseable token so the caller can fall back to the default.
const RELATIVE_RE = /^now(?:-(\d+)([smhdw]))?$/;
const UNIT_SECONDS: Record<string, number> = { s: 1, m: 60, h: 3_600, d: 86_400, w: 604_800 };

export function parseRelative(token: string, nowSeconds: number): number | null {
	const m = RELATIVE_RE.exec(token.trim());
	if (!m) return null;
	const [, amountStr, unitKey] = m;
	if (amountStr === undefined || unitKey === undefined) return nowSeconds; // bare "now"
	const unit = UNIT_SECONDS[unitKey];
	if (unit === undefined) return null;
	return nowSeconds - Number.parseInt(amountStr, 10) * unit;
}

// Resolve the effective [startTime, endTime] epoch-seconds window. Absolute epochs win when
// provided (explicit caller override); otherwise the relative tokens are used, defaulting to a wide
// now-30d..now window.
export function resolveWindow(
	params: Pick<StartQueryParams, "startTime" | "endTime" | "startRelative" | "endRelative">,
	nowSeconds: number,
): { startTime: number; endTime: number } {
	const endTime =
		typeof params.endTime === "number"
			? params.endTime
			: (parseRelative(params.endRelative ?? "now", nowSeconds) ?? nowSeconds);
	const startTime =
		typeof params.startTime === "number"
			? params.startTime
			: (parseRelative(params.startRelative ?? "now-30d", nowSeconds) ?? nowSeconds - 30 * 86_400);
	return { startTime, endTime };
}

export const startQuerySchema = startQueryObjectSchema.refine(
	(v) => (v.logGroupNames !== undefined) !== (v.logGroupIdentifiers !== undefined),
	"Provide exactly one of logGroupNames or logGroupIdentifiers",
);

export type StartQueryParams = WithEstate<z.infer<typeof startQueryObjectSchema>>;

// A CloudWatch log-group ARN is `arn:aws:logs:<region>:<acct>:log-group:<name>` and DescribeLogGroups
// returns it with a trailing `:*`. The <name> may itself contain slashes, so split off everything
// after `:log-group:` (not the last colon segment) and drop an optional `:*` suffix.
export function logGroupNameFromArn(arn: string): string {
	const m = arn.match(/:log-group:(.+?)(?::\*)?$/);
	return m?.[1] ?? arn;
}

function stripArnSuffix(arn: string): string {
	return arn.replace(/:\*$/, "");
}

interface DescribedLogGroup {
	logGroupName?: string;
	arn?: string;
	logGroupArn?: string;
}

// Exact-match a described group against the requested target. For a NAME target, only the exact
// logGroupName matches (so a "/app" query never picks up "/app-canary"). For an ARN target, match
// ONLY on the ARN (comparing both `arn` -- trailing ":*" -- and the clean `logGroupArn`).
export function matchesTarget(g: DescribedLogGroup, target: string, isNameTarget: boolean): boolean {
	if (isNameTarget) return g.logGroupName === target;
	const wanted = stripArnSuffix(target);
	if (g.arn !== undefined && stripArnSuffix(g.arn) === wanted) return true;
	if (g.logGroupArn !== undefined && stripArnSuffix(g.logGroupArn) === wanted) return true;
	return false;
}

// Defensive page cap: a single exact group cannot need many pages, but a crowded prefix could push
// the exact match past page 1. Bound the walk so a pathological prefix never loops unboundedly.
const MAX_DESCRIBE_PAGES = 20;

// Best-effort describe of the targeted log groups to read retention data for the clamp. Returns null
// on any failure -- the clamp is then simply skipped and the query is sent as-is.
async function describeRetentionGroups(
	config: AwsConfig,
	params: StartQueryParams,
): Promise<LogGroupRetention[] | null> {
	const names = params.logGroupNames;
	const identifiers = params.logGroupIdentifiers;
	const targets = names ?? identifiers ?? [];
	if (targets.length === 0) return null;
	const client = getCloudWatchLogsClient(config, params.estate);

	const perTarget = await Promise.all(
		targets.map(async (target): Promise<LogGroupRetention[]> => {
			const isNameTarget = names !== undefined;
			const wantName = isNameTarget ? target : logGroupNameFromArn(target);
			try {
				let nextToken: string | undefined;
				for (let page = 0; page < MAX_DESCRIBE_PAGES; page++) {
					const res = await client.send(
						new DescribeLogGroupsCommand({ logGroupNamePrefix: wantName, limit: 50, nextToken }),
					);
					for (const g of res.logGroups ?? []) {
						if (matchesTarget(g, target, isNameTarget)) {
							return [{ retentionInDays: g.retentionInDays, creationTime: g.creationTime }];
						}
					}
					if (!res.nextToken) break;
					nextToken = res.nextToken;
				}
				return [];
			} catch {
				return [];
			}
		}),
	);
	const collected = perTarget.flat();
	return collected.length > 0 ? collected : null;
}

export function startQuery(config: AwsConfig) {
	return wrapBlobTool({
		name: "aws_logs_start_query",
		fn: async (params: StartQueryParams) => {
			const nowSeconds = Math.floor(Date.now() / 1000);
			const { startTime, endTime } = resolveWindow(params, nowSeconds);

			// SIO-1091: best-effort retention clamp. If we can cheaply read a real retention floor and
			// the (relative) start predates it, nudge start forward to the earliest retained instant so
			// CloudWatch does not 400. This never REJECTS, never year-shifts, and never gates the query:
			// if the describe fails we just send the window as-is. The default now-30d window is inside
			// any typical retention, so the clamp is a rare edge, not the load-bearing path it once was.
			let effectiveStart = startTime;
			const groups = await describeRetentionGroups(config, params);
			if (groups && groups.length > 0) {
				const floor = resolveQueryFloor(groups, nowSeconds);
				if (Number.isFinite(floor) && effectiveStart < floor && floor <= endTime) {
					logger.info(
						{
							tool: "aws_logs_start_query",
							requestedStart: new Date(effectiveStart * 1000).toISOString(),
							clampedStart: new Date(floor * 1000).toISOString(),
						},
						"Clamped query start to the log group's earliest retained instant",
					);
					effectiveStart = floor;
				}
			}

			const client = getCloudWatchLogsClient(config, params.estate);
			return client.send(
				new StartQueryCommand({
					logGroupNames: params.logGroupNames,
					logGroupIdentifiers: params.logGroupIdentifiers,
					queryString: params.queryString,
					startTime: effectiveStart,
					endTime,
					limit: params.limit,
				}),
			);
		},
	});
}

// Re-export for consumers that assert on the ToolError shape in tests.
export type { ToolError };

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

export type FloorResult = { floor: number; isReal: boolean };

// Resolve a retention floor from describe data. `isReal` is true ONLY when a finite floor was
// actually measured (a group with retentionInDays or creationTime). No-data (null/[]/[{}] -- a
// never-expire group with no creationTime yields -Infinity) is NOT real.
//
// SIO-1082 note: we deliberately do NOT synthesize a fallback floor to DRIVE year-drift
// correction. Without a real retention floor we cannot distinguish an LLM year-shift ("meant
// recent, wrote 2025") from a legitimate historical query ("really want logs from ~400 days
// ago") -- both look like "window ~1 year back". Correcting on a guessed floor would silently
// rewrite a legitimate old query into recent logs (wrong data, no error). So year-drift
// correction is gated on isReal. The cache + single-flight below is what makes a real floor
// available on far more calls (the dominant cause of the residual failures was describe RACES
// in the fan-out, not total denials), which is the safe way to widen the guard's coverage.
export function resolveFloorFromGroups(
	groups: LogGroupRetention[] | null | undefined,
	nowSeconds: number,
): FloorResult {
	if (groups && groups.length > 0) {
		const floor = resolveQueryFloor(groups, nowSeconds);
		if (Number.isFinite(floor)) return { floor, isReal: true };
	}
	return { floor: Number.NEGATIVE_INFINITY, isReal: false };
}

// SIO-1082: cache + single-flight around an injected describe. Caches the RAW retention data
// (retentionInDays/creationTime -- stable) not the computed floor (floors are now-relative), and
// recomputes the floor per call. One successful describe protects every later call in the TTL
// window with the REAL floor; concurrent callers collapse to one in-flight describe (the idiom
// borrowed from shared/transport/readiness.ts), which also removes the race that used to return
// null and skip the guard. describe() returning null/[] or throwing yields a non-real floor.
export interface RetentionCacheEntry {
	groups: LogGroupRetention[];
	expiresAt: number;
}
const inflightDescribes = new Map<string, Promise<LogGroupRetention[] | null>>();

export async function getRetentionFloor(opts: {
	key: string;
	describe: () => Promise<LogGroupRetention[] | null>;
	nowSeconds: number;
	cache: Map<string, RetentionCacheEntry>;
	ttlMs: number;
	clock?: () => number;
}): Promise<FloorResult> {
	const { key, describe, nowSeconds, cache, ttlMs } = opts;
	const clock = opts.clock ?? (() => Date.now());

	const hit = cache.get(key);
	if (hit && hit.expiresAt > clock()) {
		return resolveFloorFromGroups(hit.groups, nowSeconds);
	}

	let flight = inflightDescribes.get(key);
	if (!flight) {
		// Promise.resolve().then(describe) so a SYNCHRONOUS throw from describe() is normalized
		// into a rejected promise (caught below -> non-real floor) rather than escaping this helper.
		flight = Promise.resolve()
			.then(describe)
			.finally(() => {
				inflightDescribes.delete(key);
			});
		inflightDescribes.set(key, flight);
	}

	let groups: LogGroupRetention[] | null;
	try {
		groups = await flight;
	} catch {
		groups = null;
	}

	// Only cache a real, non-empty result. A failure/empty leaves the entry absent so the next
	// call retries the describe rather than being pinned for the whole TTL.
	if (groups && groups.length > 0) {
		// Opportunistic eviction: on a cache miss (this write), sweep entries already past their
		// TTL so unused keys cannot accumulate over a long-running process. Bounded and cheap --
		// runs only on describe-completing calls, not cache hits.
		const nowMs = clock();
		for (const [k, v] of cache) {
			if (v.expiresAt <= nowMs) cache.delete(k);
		}
		cache.set(key, { groups, expiresAt: nowMs + ttlMs });
	}
	return resolveFloorFromGroups(groups, nowSeconds);
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
// lands it wholly inside [floor, now], the year was almost certainly shifted -- snap forward by the
// minimal number of years that fixes it. It never touches an already-valid window (endTime >= floor)
// and never produces a future-dated window (BOTH shifted start AND shifted end must stay <= now). A
// genuinely-old window that no shift can fix is returned unchanged so the existing reject path
// handles it. Calendar-year shifting via setUTCFullYear keeps leap-year dates real (Feb-29 rolls to
// Mar-1 in a non-leap target year, which is still a valid, in-range instant).
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
		// Accept the smallest shift that brings the window wholly into [floor, now]: end must reach
		// the retained slice (>= floor) AND neither bound may run past "now" -- shiftedEnd <= now
		// ensures we never hand CloudWatch a future-dated endTime.
		if (shiftedEnd >= floor && shiftedEnd <= nowSeconds && shiftedStart <= nowSeconds) {
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

// SIO-1082: module-level retention-data cache keyed by ${estate}:${sorted log-group targets},
// mirroring the client cache in services/client-factory.ts. Caches raw retentionInDays/creationTime
// (stable) with a short TTL; the floor is recomputed per call against the current now.
const RETENTION_CACHE_TTL_MS = 300_000;
const retentionCache = new Map<string, RetentionCacheEntry>();

function retentionCacheKey(params: StartQueryParams): string {
	const targets = [...(params.logGroupNames ?? params.logGroupIdentifiers ?? [])].sort();
	return `${params.estate}:${targets.join(",")}`;
}

// Describe the targeted log groups and collect their raw retention data. Returns null on any
// failure (IAM denied, throttled) or when there is nothing to describe -- getRetentionFloor turns
// that into a non-real floor (the guard is then skipped) rather than a wrong one.
// A CloudWatch log-group ARN is `arn:aws:logs:<region>:<acct>:log-group:<name>` and DescribeLogGroups
// returns it with a trailing `:*`. The <name> may itself contain slashes, so split off everything
// after `:log-group:` (not the last colon segment) and drop an optional `:*` suffix.
export function logGroupNameFromArn(arn: string): string {
	const m = arn.match(/:log-group:(.+?)(?::\*)?$/);
	return m?.[1] ?? arn;
}

// Strip the trailing `:*` DescribeLogGroups appends, so an ARN from the API compares equal to the
// suffixless ARN a caller passes as a logGroupIdentifier.
function stripArnSuffix(arn: string): string {
	return arn.replace(/:\*$/, "");
}

// Minimal view of a DescribeLogGroups result row for exact-target matching.
interface DescribedLogGroup {
	logGroupName?: string;
	arn?: string;
	logGroupArn?: string;
}

// Exact-match a described group against the requested target. For a NAME target, only the exact
// logGroupName matches (so a "/app" query never picks up "/app-canary"). For an ARN target, match
// ONLY on the ARN (comparing both `arn` -- which carries a trailing ":*" -- and the clean
// `logGroupArn`, suffixless on both sides); we do NOT fall back to logGroupName, which could
// cross-match an unrelated same-named group in a linked account.
export function matchesTarget(g: DescribedLogGroup, target: string, isNameTarget: boolean): boolean {
	if (isNameTarget) return g.logGroupName === target;
	const wanted = stripArnSuffix(target);
	if (g.arn !== undefined && stripArnSuffix(g.arn) === wanted) return true;
	if (g.logGroupArn !== undefined && stripArnSuffix(g.logGroupArn) === wanted) return true;
	return false;
}

// Defensive page cap: a single exact group cannot need many pages, but a very crowded prefix
// (50 siblings whose name our target prefixes) could push the exact match past page 1. Bound the
// walk so a pathological prefix never loops unboundedly.
const MAX_DESCRIBE_PAGES = 20;

async function describeRetentionGroups(
	config: AwsConfig,
	params: StartQueryParams,
): Promise<LogGroupRetention[] | null> {
	const names = params.logGroupNames;
	const identifiers = params.logGroupIdentifiers;
	const targets = names ?? identifiers ?? [];
	if (targets.length === 0) return null;
	const client = getCloudWatchLogsClient(config, params.estate);

	// DescribeLogGroups matches by name PREFIX, so it returns sibling groups too (querying "/app"
	// also returns "/app-canary"). We keep only the EXACT requested group -- a sibling's shorter
	// retention would otherwise wrongly tighten (or reject) the floor. We PAGINATE (a crowded
	// prefix can push the exact match past the first page) and stop as soon as it's found. Targets
	// are described concurrently and each is independently try/caught so one throttled target does
	// not discard the retention data already gathered from the others (best-effort resilience).
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

// Resilient floor resolution: cache + single-flight around describeRetentionGroups. isReal is
// true only when a finite floor was actually measured; the guard runs only in that case.
function fetchRetentionFloor(config: AwsConfig, params: StartQueryParams, nowSeconds: number): Promise<FloorResult> {
	return getRetentionFloor({
		key: retentionCacheKey(params),
		describe: () => describeRetentionGroups(config, params),
		nowSeconds,
		cache: retentionCache,
		ttlMs: RETENTION_CACHE_TTL_MS,
	});
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
			// SIO-1082: cache + single-flight makes a REAL measured floor available on far more
			// calls (the dominant residual-failure cause was describe RACES in the fan-out). The
			// whole guard runs only when a real floor is known -- year-drift correction against a
			// guessed floor could silently rewrite a legitimate historical query into recent logs.
			const { floor, isReal } = await fetchRetentionFloor(config, params, nowSeconds);
			let effectiveStart = params.startTime;
			let effectiveEnd = params.endTime;
			if (isReal) {
				// SIO-1080: correct an LLM year-shift (e.g. 2026 incident queried as 2025) BEFORE
				// clamping -- can move endTime too (clamp alone only adjusts startTime).
				const drift = correctYearDrift(effectiveStart, effectiveEnd, floor, nowSeconds);
				if (drift.shiftedYears > 0) {
					logger.warn(
						{
							tool: "aws_logs_start_query",
							shiftedYears: drift.shiftedYears,
							requestedStart: new Date(effectiveStart * 1000).toISOString(),
							correctedStart: new Date(drift.startTime * 1000).toISOString(),
							requestedEnd: new Date(effectiveEnd * 1000).toISOString(),
							correctedEnd: new Date(drift.endTime * 1000).toISOString(),
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

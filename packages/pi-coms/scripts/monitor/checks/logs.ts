// scripts/monitor/checks/logs.ts

import * as crypto from "node:crypto";
import {
	DescribeLogGroupsCommand,
	type DescribeLogGroupsCommandOutput,
	FilterLogEventsCommand,
	type FilterLogEventsCommandOutput,
} from "@aws-sdk/client-cloudwatch-logs";
import { errorMessage } from "../errors.ts";
import type { Finding } from "../report.ts";
import type { MonitorState } from "../state.ts";
import type { AwsClient } from "./alarms.ts";

// WARN is deliberately absent: in a dev account every warning line would
// become a warn finding, and warn findings trigger agent investigations.
const FILTER_PATTERN = "?ERROR ?Exception";
const MAX_GROUPS = 200;
// /aws/events/ groups hold EventBridge delivery echo (e.g. CloudTrail API
// records), not application logs; the monitor's own FilterLogEvents calls
// land there and match the pattern -- a self-referential false positive.
const EXCLUDE_PREFIXES = ["/aws/events/"];
const MAX_SIGS_PER_GROUP = 3;
const MAX_FINDINGS_PER_CYCLE = 10;
// SIO-1753: FilterLogEvents returns about 1 MB per page, oldest first, and a
// nextToken even on a partial page. Reading one page per cycle pinned
// catalog-prd-log-group inside a 2026-09-09 error storm (4832 matches per ~10 s,
// one page per 15 min) for a week, so every "current" finding was a week old.
// Pages are followed up to a budget; past it the counts are a lower bound and
// the window is still closed, because a current capped count beats a complete
// stale one.
const MAX_PAGES_PER_GROUP = 10;
// A stored position older than this is skipped forward (and said so), so
// downtime or a storm can never make the check report history as news.
const MAX_LAG_MS = 3_600_000;
// Events land in CloudWatch a few seconds after their timestamp; the window
// stops short of now so a late event is read next cycle instead of skipped.
const INGEST_SLACK_MS = 60_000;

export type LogsWindow = { start: number; end: number; skippedFrom: number | null };

// The window is [start, end], both inclusive in FilterLogEvents, so the next
// cycle's watermark is end + 1.
export function logsWindow(
	watermark: number | null,
	now: number,
	o: { lookbackMs: number; maxLagMs: number; slackMs: number },
): LogsWindow {
	const end = now - o.slackMs;
	if (watermark === null) return { start: end - o.lookbackMs, end, skippedFrom: null };
	const floor = end - o.maxLagMs;
	if (watermark < floor) return { start: floor, end, skippedFrom: watermark };
	return { start: Math.min(watermark, end), end, skippedFrom: null };
}

// Stable signature for grouping: recurring errors differ only in ids,
// timestamps, and counters.
// A digest line names the RESOURCE, so repeating the group in the summary spent
// 40 characters saying nothing -- and several signatures in one group then
// produced several byte-identical summaries ("3 error-pattern event(s) in
// /ecs/fargate/catalog-prd-log-group" four times over, live on eu-oit-prd).
// They are genuinely distinct findings (dedup_key is logs:<group>:<signature>),
// so they must not be collapsed; they need to be TOLD APART. A short excerpt of
// the sample message does that, where the 12-char signature hash could not.
//
// The excerpt is untrusted log text: newlines are folded so one event cannot
// forge extra digest lines, and it is hard-capped well inside the summary's own
// budget.
const SAMPLE_EXCERPT = 80;

export function summariseLogSample(sample: string, max = SAMPLE_EXCERPT): string {
	const oneLine = sample.replace(/\s+/g, " ").trim();
	if (oneLine.length <= max) return oneLine;
	// `max` bounds the WHOLE excerpt, ellipsis included, so a caller's cap is
	// the real budget rather than max + 3.
	return `${oneLine.slice(0, max - 3).trimEnd()}...`;
}

export function logSignature(message: string): string {
	const normalized = message
		.replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z?/g, "<ts>")
		// UUIDs before the hex pass: their 4-char middle segments would
		// otherwise survive normalization and give every event a fresh
		// signature, defeating dedup.
		.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<uuid>")
		.replace(/\b[0-9a-f]{8,}\b/gi, "<hex>")
		// Mixed alphanumeric ids (option codes like UW0UW061470LZ, article
		// keys): a fresh signature per SKU defeats dedup exactly the way raw
		// UUIDs did. A token of 8+ word chars with 2+ digits is an id, not a
		// word; class names with a single version digit (ImagesClientV2) stay.
		.replace(/\b[A-Za-z0-9_]{8,}\b/g, (t) => ((t.match(/\d/g)?.length ?? 0) >= 2 ? "<id>" : t))
		.replace(/\d+/g, "<n>")
		.slice(0, 120);
	return crypto.createHash("sha256").update(normalized).digest("hex").slice(0, 12);
}

export type CheckLogsOpts = {
	now?: number;
	reAlertMs?: number;
	lookbackMs?: number;
	filterPattern?: string;
	maxGroups?: number;
	excludePrefixes?: string[];
	maxSigsPerGroup?: number;
	maxFindingsPerCycle?: number;
	maxPagesPerGroup?: number;
	maxLagMs?: number;
	slackMs?: number;
};

export async function checkLogs(client: AwsClient, state: MonitorState, opts: CheckLogsOpts = {}): Promise<Finding[]> {
	const now = opts.now ?? Date.now();
	const reAlertMs = opts.reAlertMs ?? 86_400_000;
	const lookbackMs = opts.lookbackMs ?? 900_000;
	const filterPattern = opts.filterPattern ?? FILTER_PATTERN;
	const maxGroups = opts.maxGroups ?? MAX_GROUPS;
	const excludePrefixes = opts.excludePrefixes ?? EXCLUDE_PREFIXES;
	const maxSigsPerGroup = opts.maxSigsPerGroup ?? MAX_SIGS_PER_GROUP;
	const maxFindingsPerCycle = opts.maxFindingsPerCycle ?? MAX_FINDINGS_PER_CYCLE;
	const maxPages = opts.maxPagesPerGroup ?? MAX_PAGES_PER_GROUP;
	const windowOpts = { lookbackMs, maxLagMs: opts.maxLagMs ?? MAX_LAG_MS, slackMs: opts.slackMs ?? INGEST_SLACK_MS };
	const findings: Finding[] = [];
	// The cap bounds investigations, so only warn findings spend it.
	let warned = 0;
	// (group, signature, count) that hit a cap this cycle: journaled as one
	// info finding so history survives without an investigation storm.
	const overflow: { group: string; signature: string; count: number }[] = [];
	// Groups whose stored position was past the lag bound. One notice per cycle,
	// not per group: after downtime every group is behind at once.
	const skipped: { group: string; from: string; resumedAt: string }[] = [];

	// Paginate: DescribeLogGroups caps pages at 50 and sorts alphabetically,
	// so a single page permanently hides every group after the 50th.
	const groups: string[] = [];
	let nextToken: string | undefined;
	do {
		const resp = (await client.send(
			new DescribeLogGroupsCommand({ limit: 50, nextToken }),
		)) as DescribeLogGroupsCommandOutput;
		for (const g of resp.logGroups ?? []) {
			const name = g.logGroupName;
			if (!name) continue;
			if (excludePrefixes.some((p) => name.startsWith(p))) continue;
			groups.push(name);
		}
		nextToken = resp.nextToken;
	} while (nextToken && groups.length < maxGroups);
	groups.splice(maxGroups);

	// One unreadable group must not kill the scan: a denied group is a scoping
	// fact (name-scoped log IAM), reported once as info, and the rest of the
	// estate still gets scanned this cycle.
	const groupErrors: string[] = [];
	for (const group of groups) {
		const wmKey = `logs:${group}`;
		const win = logsWindow(state.getWatermark(wmKey), now, windowOpts);
		const bySig = new Map<string, { count: number; sample: string; lastTs: number }>();
		let truncated = false;
		try {
			let token: string | undefined;
			let pages = 0;
			do {
				const resp = (await client.send(
					new FilterLogEventsCommand({
						logGroupName: group,
						startTime: win.start,
						endTime: win.end,
						filterPattern,
						nextToken: token,
					}),
				)) as FilterLogEventsCommandOutput;
				pages++;
				// FilteredLogEvent marks both fields optional; every real event carries them.
				for (const e of (resp.events ?? []) as { timestamp: number; message: string }[]) {
					const sig = logSignature(e.message ?? "");
					const cur = bySig.get(sig) ?? { count: 0, sample: (e.message ?? "").slice(0, 300), lastTs: e.timestamp };
					cur.count++;
					cur.lastTs = Math.max(cur.lastTs, e.timestamp);
					bySig.set(sig, cur);
				}
				token = resp.nextToken;
			} while (token && pages < maxPages);
			truncated = token !== undefined;
		} catch (e) {
			const msg = errorMessage(e);
			if (/not authorized|AccessDenied|UnauthorizedOperation/i.test(msg)) {
				const scopeKey = `logs:scope:${group}:`;
				if (state.shouldAlert(scopeKey)) {
					state.markAlerted(scopeKey, "logs");
					findings.push({
						family: "logs",
						severity: "info",
						resource: group,
						summary: `Log group ${group} is outside the readable name scope (not inspected)`,
						dedup_key: scopeKey,
						evidence: { error: msg.slice(0, 300) },
						at: new Date(now).toISOString(),
					});
				}
			} else {
				groupErrors.push(`${group}: ${msg}`);
			}
			// A failed scan keeps the old position: nothing in the window was read.
			continue;
		}
		// Closed even when truncated or empty: an empty window that never closed
		// is how a quiet group's scan used to grow without bound.
		state.setWatermark(wmKey, win.end + 1);
		const windowEvidence = { from: new Date(win.start).toISOString(), to: new Date(win.end).toISOString() };

		if (win.skippedFrom !== null) {
			skipped.push({ group, from: new Date(win.skippedFrom).toISOString(), resumedAt: windowEvidence.from });
		}

		// Loudest signatures first; everything past the caps is history, not
		// an alert.
		const ranked = [...bySig.entries()].sort((a, b) => b[1].count - a[1].count);
		let emitted = 0;
		for (const [sig, agg] of ranked) {
			const key = `logs:${group}:${sig}`;
			if (!state.shouldAlert(key, reAlertMs)) continue;
			if (emitted >= maxSigsPerGroup || warned >= maxFindingsPerCycle) {
				overflow.push({ group, signature: sig, count: agg.count });
				continue;
			}
			state.markAlerted(key, "logs");
			emitted++;
			warned++;
			const excerpt = summariseLogSample(agg.sample);
			const count = truncated ? `at least ${agg.count}` : `${agg.count}`;
			findings.push({
				family: "logs",
				severity: "warn",
				resource: group,
				summary: excerpt ? `${count} error-pattern event(s): ${excerpt}` : `${count} error-pattern event(s)`,
				dedup_key: key,
				// The window travels with the finding so the investigating agent
				// queries the same time range instead of guessing one.
				evidence: {
					count: agg.count,
					sample: agg.sample,
					signature: sig,
					window: windowEvidence,
					...(truncated ? { truncated: true } : {}),
				},
				at: new Date(now).toISOString(),
			});
		}
	}

	if (skipped.length > 0) {
		findings.push({
			family: "logs",
			severity: "info",
			resource: "logs-skipped",
			summary: `${skipped.length} log group(s) were more than ${windowOpts.maxLagMs / 3_600_000}h behind and skipped forward (errors in the gap are not reported)`,
			dedup_key: `logs:skipped:${new Date(now).toISOString()}`,
			evidence: { skipped },
			at: new Date(now).toISOString(),
		});
	}
	if (overflow.length > 0) {
		findings.push({
			family: "logs",
			severity: "info",
			resource: "logs-overflow",
			summary: `${overflow.length} further error signature(s) over the per-cycle caps (kept in history, not investigated)`,
			dedup_key: `logs:overflow:${new Date(now).toISOString()}`,
			evidence: { overflow },
			at: new Date(now).toISOString(),
		});
	}
	// Non-auth failures on every group is a real check failure, not scoping.
	if (groups.length > 0 && groupErrors.length === groups.length) {
		throw new Error(`all ${groups.length} log group scan(s) failed: ${groupErrors[0]}`);
	}
	return findings;
}

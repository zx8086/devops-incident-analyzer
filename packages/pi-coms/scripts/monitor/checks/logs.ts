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
// The window stops short of now so an event ingested after its timestamp is
// read next cycle instead of skipped. Measured 2026-09-16 (ingestionTime minus
// timestamp, 16 groups in three prd accounts): ECS awslogs, Lambda, Container
// Insights and the CloudWatch agent all under 10 s, but /aws/msk/brokers
// delivers in ~60 s batches (p50 45 s, max 60.6 s, 5.6% over 60 s). Five
// minutes is ~5x the worst observed delay; it costs 5 minutes of detection
// latency on a 15-minute cycle.
const INGEST_SLACK_MS = 300_000;

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
// SIO-1832: 80 cut the excerpt mid-token on real traffic
// (`...Cannot invoke "java.util.UUID.toString()" bec...`), which defeats the
// purpose above -- an excerpt that stops before the distinguishing part tells
// two signatures apart no better than the hash did. The digest now wraps the
// summary onto its own lines, so a wider excerpt costs no readability.
// SIO-1873: this used to be costed against a 10-entry digest cap. That cap is
// gone (it hid whole families), so the bound is now the SNS 256 KiB message
// limit that report-email.ts truncates against: a 200-char excerpt is ~2 KB per
// ten findings, and the worst real account measured 11 KB in total.
const SAMPLE_EXCERPT = 200;

export function summariseLogSample(sample: string, max = SAMPLE_EXCERPT): string {
	const oneLine = sample.replace(/\s+/g, " ").trim();
	if (oneLine.length <= max) return oneLine;
	// `max` bounds the WHOLE excerpt, ellipsis included, so a caller's cap is
	// the real budget rather than max + 3.
	return `${oneLine.slice(0, max - 3).trimEnd()}...`;
}

// SIO-1820: one incident used to become many findings. Measured live
// (eu-shared-services-prd, 2026-09-19): CloudWatch delivers a Java stack trace
// as SEPARATE events, one line each -- 0 of 8 sampled events were multi-line.
// So the leading log line, the exception line, each `at` frame, the suppressed
// FluxOnAssembly block and the `Caused by:` line arrive as six events and, at
// 120 normalized characters apiece, became six signatures.
//
// A per-event function cannot fix that: when it sees an `at` frame it has no
// `Caused by:` line to key on. The grouping therefore happens across events,
// in collapseTraceEvents below; these two helpers classify one line.

// A pure continuation line of a trace: a stack frame, a suppressed/caused
// header, or Reactor's checkpoint decoration. Carries no identity of its own.
const TRACE_CONTINUATION = /^[ \t]*(?:at\s|\.{3}\s*\d+\s+more\b|Suppressed:|Caused by:|\*__checkpoint\b)/;
// A line naming an exception type is an identity line even without a prefix.
const EXCEPTION_TYPE = /[\w.$]*(?:Exception|Error|Throwable)\b/;

export function isTraceContinuation(message: string): boolean {
	return TRACE_CONTINUATION.test(message);
}

// The deepest `Caused by:` is the root cause; Java prints it last.
export function causedByText(message: string): string | null {
	const m = /^[ \t]*Caused by:[ \t]*(.+)$/.exec(message);
	return m ? m[1].trim() : null;
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

// SIO-1820: fold a group's events into incidents. A continuation line belongs
// to the most recent identity line IN ITS OWN STREAM -- concurrent requests
// interleave their traces in a shared group, so a global "previous event" would
// staple one request's frames onto another's exception.
//
// A `Caused by:` line is a continuation AND the best identity available: it
// upgrades the incident's signature to the root cause, which is what makes two
// occurrences of the same fault dedup even when their leading lines differ.
//
// A continuation with no preceding identity (the window opened mid-trace) keeps
// its own signature rather than being dropped: losing it would under-report.
export type TraceEvent = { timestamp: number; message: string; logStreamName?: string };
export type CollapsedEvent = { signature: string; message: string; timestamp: number; frames: number };

// `open` is the caller's: FilterLogEvents pages, and an exception can end one
// page while its frames and `Caused by:` line begin the next. A map created
// here would reset at every boundary, splitting that trace into two incidents
// and leaving the first without its root-cause signature. Callers that read a
// whole group in one go can omit it.
export function collapseTraceEvents(
	events: TraceEvent[],
	sign: (m: string) => string,
	open: Map<string, CollapsedEvent> = new Map(),
): CollapsedEvent[] {
	const out: CollapsedEvent[] = [];
	for (const e of events) {
		const message = e.message ?? "";
		const stream = e.logStreamName ?? "";
		const current = open.get(stream);
		if (isTraceContinuation(message) && current) {
			current.frames++;
			current.timestamp = Math.max(current.timestamp, e.timestamp);
			// The deepest cause wins: re-signing on `Caused by:` is what collapses
			// "404 from POST /prices" and "502 from POST /prices" onto the one
			// ConnectException underneath them.
			const cause = causedByText(message);
			if (cause) current.signature = sign(cause);
			continue;
		}
		const incident: CollapsedEvent = { signature: sign(message), message, timestamp: e.timestamp, frames: 1 };
		out.push(incident);
		// Only a line that can head a trace opens one. A plain one-line ERROR
		// with no exception type is complete in itself, and letting it adopt the
		// next frame would merge unrelated events.
		if (EXCEPTION_TYPE.test(message)) open.set(stream, incident);
		else open.delete(stream);
	}
	return out;
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
		// SIO-1820: per GROUP, not per page -- a trace straddling a page boundary
		// must stay one incident. Scoped to the group so one group's open trace
		// can never adopt another's frames.
		const openTraces = new Map<string, CollapsedEvent>();
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
				// SIO-1820: fold events into incidents first, so a stack trace's
				// separate one-line events count as ONE occurrence signed by its root
				// cause instead of one finding per frame. `openTraces` lives OUTSIDE
				// the page loop: a trace can straddle a page boundary, and resetting
				// per page would split it back into the findings this exists to merge.
				const events = (resp.events ?? []) as TraceEvent[];
				for (const inc of collapseTraceEvents(events, logSignature, openTraces)) {
					const cur = bySig.get(inc.signature) ?? {
						count: 0,
						sample: inc.message.slice(0, 300),
						lastTs: inc.timestamp,
					};
					cur.count++;
					cur.lastTs = Math.max(cur.lastTs, inc.timestamp);
					bySig.set(inc.signature, cur);
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

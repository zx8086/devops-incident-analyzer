// scripts/monitor/checks/db-events.ts
import { DescribeEventsCommand, type DescribeEventsCommandOutput, type Event as RdsEvent } from "@aws-sdk/client-rds";
import { type Finding, overflowFinding, type Severity } from "../report.ts";
import type { MonitorState } from "../state.ts";
import type { AwsClient } from "./alarms.ts";

// SIO-1749: rds:DescribeEvents was granted and unread.
//
// The discriminator is the API's own, and it is unusually clean: RDS tags every
// event with EventCategories, and DescribeEvents filters on them SERVER-side.
// Verified against production: an account with 90 events over 14 days returns 0
// once filtered to the failure categories, because all 90 were automated
// snapshot activity ("Creating automated cluster snapshot", category `backup`).
// So the noise never reaches this code at all -- the cheapest possible
// discriminator, and no threshold to argue about.
//
// ElastiCache is deliberately NOT read here, though elasticache:DescribeEvents
// is equally granted. Its events carry no EventCategories field at all
// (verified: Date, Message, SourceIdentifier, SourceType and nothing else), so
// there is no server-side filter and no categorical discriminator -- only
// message text. Every message observed in production was benign or
// self-healing ("Recovering cache nodes", "Finished recovery for cache nodes",
// a scheduled maintenance-window replacement). Classifying that needs a
// corpus of real ElastiCache FAILURES, which this fleet has not produced.
const CATEGORIES = ["failure", "failover", "low storage", "availability"];
// Severity per category. A failure or an exhausted disk is an outage; a
// failover is the HA mechanism working, which is still worth knowing because
// something underneath it broke.
const CRITICAL_CATEGORIES = new Set(["failure", "low storage"]);
const FIRST_LOOKBACK_MINUTES = 60;
const MAX_LOOKBACK_MINUTES = 20_160; // the API's own 14-day ceiling
const REALERT_MS = 86_400_000;
const MAX_FINDINGS = 10;

export type CheckDbEventsOpts = { now?: number };

export function severityForCategories(categories: string[]): Severity {
	return categories.some((c) => CRITICAL_CATEGORIES.has(c)) ? "critical" : "warn";
}

export async function checkDbEvents(
	client: AwsClient,
	state: MonitorState,
	opts: CheckDbEventsOpts = {},
): Promise<Finding[]> {
	const now = opts.now ?? Date.now();
	const at = new Date(now).toISOString();
	const since = state.getWatermark("db-events:rds");
	// Ask only for the window since the last look, so a restart does not replay
	// two weeks of history, and never more than the API will answer for.
	const minutes = since
		? Math.min(MAX_LOOKBACK_MINUTES, Math.max(1, Math.ceil((now - since) / 60_000)))
		: FIRST_LOOKBACK_MINUTES;

	const findings: Finding[] = [];
	let omitted = 0;
	let newest = since ?? now - minutes * 60_000;
	let nextMarker: string | undefined;
	const events: RdsEvent[] = [];
	do {
		const resp = (await client.send(
			new DescribeEventsCommand({ Duration: minutes, EventCategories: CATEGORIES, Marker: nextMarker }),
		)) as DescribeEventsCommandOutput;
		events.push(...(resp.Events ?? []));
		nextMarker = resp.Marker;
	} while (nextMarker);

	for (const e of events) {
		const ts = e.Date ? new Date(e.Date).getTime() : now;
		if (since !== null && ts <= since) continue;
		if (ts > newest) newest = ts;
		const source = e.SourceIdentifier ?? "unknown";
		const categories = e.EventCategories ?? [];
		const severity = severityForCategories(categories);
		// Keyed on source plus category rather than the message, so a database
		// flapping through repeated failovers is one alert a day, not one per
		// event.
		const key = `db-events:${source}:${categories.sort().join("+") || "uncategorized"}`;
		if (!state.shouldAlert(key, REALERT_MS)) continue;
		state.markAlerted(key, "db-events");
		findings.push({
			family: "db-events",
			severity,
			resource: source,
			summary: `RDS ${e.SourceType ?? "resource"} ${source} reported ${categories.join(", ") || "an event"}: ${e.Message ?? ""}`,
			dedup_key: key,
			evidence: {
				sourceIdentifier: source,
				sourceType: e.SourceType ?? null,
				sourceArn: e.SourceArn ?? null,
				categories,
				message: e.Message ?? null,
				date: e.Date ?? null,
			},
			at,
		});
		if (findings.length >= MAX_FINDINGS) {
			// Count what is left rather than deriving it: events already inside
			// the re-alert window were processed, not omitted.
			omitted = events.length - (events.indexOf(e) + 1);
			break;
		}
	}

	if (omitted > 0) {
		findings.push(overflowFinding("db-events", omitted, MAX_FINDINGS, at));
	} else {
		// Bounded by the scan start, as elsewhere: an event written during the
		// scan must be seen next cycle rather than skipped.
		state.setWatermark("db-events:rds", Math.min(newest, now));
	}
	return findings;
}

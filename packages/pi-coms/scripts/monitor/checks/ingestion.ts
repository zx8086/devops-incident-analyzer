// scripts/monitor/checks/ingestion.ts
import { GetMetricDataCommand, type GetMetricDataCommandOutput } from "@aws-sdk/client-cloudwatch";
import type { Finding } from "../report.ts";
import type { MonitorState } from "../state.ts";
import type { AwsClient } from "./alarms.ts";

// The logs check finds errors that are present; this finds logging that
// stopped. A service that dies quietly produces zero findings there.
const EXCLUDE_PREFIXES = ["/aws/events/"];
const MIN_EVENTS = 10;
// SIO-1711: one quiet hour is not an outage. An event-driven function can have a
// same-hour 7d median of 27 and still legitimately see 0 in any single hour, so
// the old single-hour test fired constantly (warn -> info resumed -> warn, six
// investigations on one Lambda log group). Require this many CONSECUTIVE zero
// hours ending at the observed hour; the hourly series is already fetched below,
// so the gate costs no extra API call and no state.
// SIO-1739: three hours was still not enough for a forwarder whose own week held
// three-hour gaps every day (49 of 72 hours zero, six warns in 48h). The gate is
// now the LONGER of ZERO_HOURS and the group's own longest quiet run in the
// baseline window plus one: a stop is only a stop once it outlasts what the
// group has done before. Same series, still no extra call.
const ZERO_HOURS = 3;
const BASELINE_DAYS = 7;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const WINDOW_HOURS = BASELINE_DAYS * 24;

// Metrics Insights grammar is unforgiving; keep the expression verbatim and
// substitute nothing.
const EXPRESSION =
	'SELECT SUM(IncomingLogEvents) FROM SCHEMA("AWS/Logs", LogGroupName) GROUP BY LogGroupName ORDER BY SUM() DESC LIMIT 500';

export type CheckIngestionOpts = {
	now?: number;
	minEvents?: number;
	zeroHours?: number;
	excludePrefixes?: string[];
};

export async function checkIngestion(
	client: AwsClient,
	state: MonitorState,
	opts: CheckIngestionOpts = {},
): Promise<Finding[]> {
	const now = opts.now ?? Date.now();
	const minEvents = opts.minEvents ?? MIN_EVENTS;
	const zeroHours = Math.max(1, Math.floor(opts.zeroHours ?? ZERO_HOURS));
	const excludePrefixes = opts.excludePrefixes ?? EXCLUDE_PREFIXES;
	// Whole-hour boundaries: the last complete hour is the observation, the
	// same hour on the prior 7 days is the baseline. Same-hour comparison makes
	// the nightly scale-to-zero silent by construction.
	const endMs = Math.floor(now / HOUR_MS) * HOUR_MS;
	const lastHourMs = endMs - HOUR_MS;
	const startMs = lastHourMs - BASELINE_DAYS * DAY_MS;

	const series = new Map<string, Map<number, number>>();
	let nextToken: string | undefined;
	do {
		const resp = (await client.send(
			new GetMetricDataCommand({
				MetricDataQueries: [{ Id: "ingest", Expression: EXPRESSION, Period: 3600 }],
				StartTime: new Date(startMs),
				EndTime: new Date(endMs),
				NextToken: nextToken,
			}),
		)) as GetMetricDataCommandOutput;
		for (const r of resp.MetricDataResults ?? []) {
			const group: string = r.Label ?? "";
			if (!group || excludePrefixes.some((p) => group.startsWith(p))) continue;
			const points = series.get(group) ?? new Map<number, number>();
			const ts: Date[] = r.Timestamps ?? [];
			const vals: number[] = r.Values ?? [];
			for (let i = 0; i < ts.length; i++) points.set(new Date(ts[i]).getTime(), vals[i] ?? 0);
			series.set(group, points);
		}
		nextToken = resp.NextToken;
	} while (nextToken);

	const findings: Finding[] = [];
	for (const [group, points] of series) {
		// Hours back from the observed hour; CloudWatch omits zero-count hours,
		// so an absent point IS a zero hour. A group with no points at all
		// therefore reads as a full zero run; the baseline floor below, not the
		// zero-run gate, is what keeps a brand-new group quiet (its history is
		// absent too, so the median is 0).
		const at = (h: number): number => points.get(lastHourMs - h * HOUR_MS) ?? 0;
		const observed = at(0);
		let zeroRun = 0;
		while (zeroRun <= WINDOW_HOURS && at(zeroRun) === 0) zeroRun++;
		// The group's own longest quiet run before the current one. A group
		// younger than the window reads its missing past as one long zero run
		// and cannot alert until it has lived through it -- the same window the
		// median floor already demands.
		let histMaxZeroRun = 0;
		let run = 0;
		for (let h = zeroRun; h <= WINDOW_HOURS; h++) {
			run = at(h) === 0 ? run + 1 : 0;
			if (run > histMaxZeroRun) histMaxZeroRun = run;
		}
		const gateHours = Math.max(zeroHours, histMaxZeroRun + 1);
		const sameHour7d: number[] = [];
		for (let d = 1; d <= BASELINE_DAYS; d++) sameHour7d.push(at(d * 24));
		const history = [...sameHour7d].sort((a, b) => a - b);
		const baseline = history[Math.floor(history.length / 2)];
		// Trailing colon terminates the key: group names nest (/ecs/a prefixes
		// /ecs/a-b) but cannot contain ":", so prefix-based fingerprint clears
		// stay exact.
		const key = `ingest:${group}:`;
		const atIso = new Date(now).toISOString();

		if (zeroRun >= gateHours && baseline >= minEvents) {
			if (!state.shouldAlert(key)) continue;
			state.markAlerted(key, "ingestion");
			// The spoke gets the series the gate was decided on, so it diagnoses
			// from the monitor's numbers instead of re-deriving a baseline (SIO-1739).
			const last24h: number[] = [];
			for (let h = 23; h >= 0; h--) last24h.push(at(h));
			findings.push({
				family: "ingestion",
				severity: "warn",
				resource: group,
				summary: `Log ingestion stopped in ${group}: 0 events for ${zeroRun}h (longest quiet run in the prior 7d: ${histMaxZeroRun}h) vs same-hour 7d median ${baseline}`,
				dedup_key: key,
				evidence: {
					observed,
					zeroRun,
					gateHours,
					histMaxZeroRun,
					baselineMedian: baseline,
					sameHour7d,
					last24h,
					hourUtc: new Date(lastHourMs).toISOString(),
				},
				at: atIso,
			});
		} else if (observed > 0 && !state.shouldAlert(key)) {
			state.clearAlerts(key);
			findings.push({
				family: "ingestion",
				severity: "info",
				resource: group,
				summary: `Log ingestion resumed in ${group}: ${observed} event(s) last hour`,
				dedup_key: `${key}:recovered:${new Date(lastHourMs).toISOString()}`,
				evidence: { observed, hourUtc: new Date(lastHourMs).toISOString() },
				at: atIso,
			});
		}
	}
	return findings;
}

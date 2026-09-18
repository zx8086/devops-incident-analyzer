// packages/agent/src/incident-time.ts
// SIO-1815: the explicit timestamps a user pastes, read deterministically.
//
// Live run 2026-09-18: the query carried `@timestamp - Sep 17, 2026 @ 21:10:42.707`, a
// Kibana timestamp in the BROWSER's zone (CEST). Two things went wrong. The normalizer
// returned its default now-24h window, so the incident fell inside it by luck and an older
// one would have been excluded outright. And nothing knew the zone, so the report stamped
// the anchor 21:10:42Z when the event was at 19:10:42Z; the pi spoke caught it, and the
// two-hour difference became an "unexplained interval" in the report's own Gaps section.
//
// None of this is a job for a model: date arithmetic is exactly what SIO-1091 took away
// from one. The zone comes from the browser, the conversion is Intl, and every consumer
// is handed finished UTC values.

import type { IncidentAnchor, NormalizedIncident } from "@devops-agent/shared";

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

// ponytail: the three shapes seen in pasted log lines. Relative phrases ("last 30 min")
// stay with the normalizer's LLM; add a shape here when a run shows one, not before.
//   Kibana:        Sep 17, 2026 @ 21:10:42.707
//   ISO, zoned:    2026-09-17T21:10:42.707Z | 2026-09-17T21:10:42+02:00
//   ISO, unzoned:  2026-09-17T21:10:42.707  | 2026-09-17 21:10:42
const KIBANA_RE = /\b([A-Za-z]{3})[a-z]* (\d{1,2}), (\d{4}) @ (\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?/g;
const ISO_RE = /\b(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:[.,](\d{1,3}))?(Z|[+-]\d{2}:?\d{2})?/g;

const MAX_ANCHORS = 5;

type WallTime = { year: number; month: number; day: number; hour: number; minute: number; second: number; ms: number };

export function isValidTimeZone(timeZone: string | undefined): timeZone is string {
	if (!timeZone) return false;
	try {
		new Intl.DateTimeFormat("en-US", { timeZone });
		return true;
	} catch {
		return false;
	}
}

// Milliseconds the zone is ahead of UTC at the given instant.
function zoneOffsetMs(instantMs: number, timeZone: string): number {
	const parts = new Intl.DateTimeFormat("en-US", {
		timeZone,
		hourCycle: "h23",
		year: "numeric",
		month: "numeric",
		day: "numeric",
		hour: "numeric",
		minute: "numeric",
		second: "numeric",
	}).formatToParts(new Date(instantMs));
	const n = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
	const asUtc = Date.UTC(n("year"), n("month") - 1, n("day"), n("hour"), n("minute"), n("second"));
	return asUtc - Math.floor(instantMs / 1000) * 1000;
}

// A wall-clock reading in `timeZone`, as a UTC instant. The offset is looked up at the
// guess and again at the result: across a DST change the first lookup is an hour out.
export function wallTimeToUtcMs(wall: WallTime, timeZone: string): number {
	const naive = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second, wall.ms);
	const first = naive - zoneOffsetMs(naive, timeZone);
	return naive - zoneOffsetMs(first, timeZone);
}

// Date.UTC never rejects: 2026-02-31 silently becomes March 3, and that would then be
// handed to every sub-agent as the AUTHORITATIVE incident time (Greptile, PR #846;
// reproduced). A reading is real only if the calendar gives the same components back.
function isRealWallTime(w: WallTime): boolean {
	if (w.hour > 23 || w.minute > 59 || w.second > 59) return false;
	const d = new Date(Date.UTC(w.year, w.month - 1, w.day));
	return d.getUTCFullYear() === w.year && d.getUTCMonth() === w.month - 1 && d.getUTCDate() === w.day;
}

// A wall time that does not exist in the zone (02:30 on the night the clocks go forward)
// converts to SOME instant, just not the one written. Reading the result back in the zone
// exposes it: the hour comes back different.
function existsInZone(w: WallTime, utcMs: number, timeZone: string): boolean {
	const back = new Date(utcMs + zoneOffsetMs(utcMs, timeZone));
	return back.getUTCHours() === w.hour && back.getUTCMinutes() === w.minute && back.getUTCDate() === w.day;
}

const padMs = (frac: string | undefined) => Number((frac ?? "0").padEnd(3, "0"));

// Every explicit timestamp in the text, as UTC. `timeZone` is the reader's zone (from the
// browser) and applies to the Kibana shape, which Kibana renders in the viewer's zone.
// Whenever the zone is not actually known the reading is UTC and marked `assumed`, so a
// consumer can say it was a guess instead of presenting it as fact.
export function extractIncidentAnchors(text: string, timeZone: string | undefined): IncidentAnchor[] {
	const zone = isValidTimeZone(timeZone) ? timeZone : "UTC";
	const assumed = zone !== timeZone;
	const found: Array<IncidentAnchor & { index: number }> = [];

	for (const m of text.matchAll(KIBANA_RE)) {
		const month = MONTHS.indexOf((m[1] ?? "").toLowerCase()) + 1;
		const wall: WallTime = {
			year: Number(m[3]),
			month,
			day: Number(m[2]),
			hour: Number(m[4]),
			minute: Number(m[5]),
			second: Number(m[6]),
			ms: padMs(m[7]),
		};
		if (month === 0 || !isRealWallTime(wall)) continue;
		const kibanaUtcMs = wallTimeToUtcMs(wall, zone);
		if (!existsInZone(wall, kibanaUtcMs, zone)) continue;
		found.push({
			raw: m[0],
			utc: new Date(kibanaUtcMs).toISOString(),
			timeZone: zone,
			assumed,
			index: m.index ?? 0,
		});
	}

	for (const m of text.matchAll(ISO_RE)) {
		const wall: WallTime = {
			year: Number(m[1]),
			month: Number(m[2]),
			day: Number(m[3]),
			hour: Number(m[4]),
			minute: Number(m[5]),
			second: Number(m[6]),
			ms: padMs(m[7]),
		};
		if (!isRealWallTime(wall)) continue;
		const offset = m[8];
		if (offset) {
			// Already absolute: the zone is in the text, so nothing is assumed.
			const normalized = offset === "Z" ? "Z" : `${offset.slice(0, 3)}:${offset.slice(-2)}`;
			const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}.${String(wall.ms).padStart(3, "0")}${normalized}`;
			const at = Date.parse(iso);
			if (!Number.isFinite(at)) continue;
			found.push({ raw: m[0], utc: new Date(at).toISOString(), timeZone: "UTC", assumed: false, index: m.index ?? 0 });
			continue;
		}
		// Unzoned ISO is what a pasted LOG LINE carries, and that is the SERVER's clock
		// (containers log UTC far more often than not), not the reader's. Only the Kibana
		// shape above is known to be browser-local. Reading this one in the browser zone
		// would reintroduce the two-hour error in the other direction, so it is taken as UTC
		// and always marked assumed: the zone genuinely is not known.
		found.push({
			raw: m[0],
			utc: new Date(wallTimeToUtcMs(wall, "UTC")).toISOString(),
			timeZone: "UTC",
			assumed: true,
			index: m.index ?? 0,
		});
	}

	const seen = new Set<string>();
	return found
		.sort((a, b) => a.index - b.index)
		.filter((a) => {
			if (seen.has(a.utc)) return false;
			seen.add(a.utc);
			return true;
		})
		.slice(0, MAX_ANCHORS)
		.map(({ index: _index, ...anchor }) => anchor);
}

// The INVESTIGATION window: what the digest, deploy correlation and recurrence checks scope
// to. A day before (SIO-1296: causes and deploys precede onset, and a 1h window under-scoped
// them) to a day after, never past now -- what happened since is part of the picture.
const INVESTIGATION_BEFORE_MS = 24 * 3600_000;
const INVESTIGATION_AFTER_MS = 24 * 3600_000;

export function investigationWindowFor(anchors: IncidentAnchor[], now: Date): { from: string; to: string } | undefined {
	const times = anchors.map((a) => Date.parse(a.utc)).filter(Number.isFinite);
	if (times.length === 0) return undefined;
	const from = Math.min(...times) - INVESTIGATION_BEFORE_MS;
	const to = Math.min(now.getTime(), Math.max(...times) + INVESTIGATION_AFTER_MS);
	// An anchor in the future (a typo, a wrong year) would give to < from; leave the
	// window to the normalizer rather than emit an inverted one.
	return to > from ? { from: new Date(from).toISOString(), to: new Date(to).toISOString() } : undefined;
}

// The INCIDENT window: the narrow slice to query FIRST, so a row is attributed to the
// incident only if it happened at the incident. Two hours before covers a job that ran for
// an hour before it threw (this one polled for 65 minutes); one after covers the fallout.
const INCIDENT_BEFORE_MS = 2 * 3600_000;
const INCIDENT_AFTER_MS = 3600_000;

export type IncidentQueryWindow = {
	fromIso: string;
	toIso: string;
	fromEpochSeconds: number;
	toEpochSeconds: number;
	// "now-<n>m" tokens for tools that take a relative window (aws_logs_start_query, SIO-1091).
	fromRelative: string;
	toRelative: string;
};

const MAX_INCIDENT_WINDOWS = 3;

// One window per timestamp the user gave, overlapping ones merged. NOT just the first
// (Greptile, PR #846): a pasted log excerpt often opens with an older line, and a window
// built from text order alone would aim the incident query at history. Lines seconds
// apart merge into one window; events days apart each get their own, earliest first.
export function incidentQueryWindows(anchorUtcs: string[], nowIso: string): IncidentQueryWindow[] {
	const now = Date.parse(nowIso);
	if (!Number.isFinite(now)) return [];
	const spans = anchorUtcs
		.map((utc) => Date.parse(utc))
		.filter(Number.isFinite)
		.map((at) => ({ from: at - INCIDENT_BEFORE_MS, to: Math.min(now, at + INCIDENT_AFTER_MS) }))
		.filter((s) => s.to > s.from)
		.sort((a, b) => a.from - b.from);
	const merged: Array<{ from: number; to: number }> = [];
	for (const span of spans) {
		const last = merged.at(-1);
		if (last && span.from <= last.to) last.to = Math.max(last.to, span.to);
		else merged.push({ ...span });
	}
	return merged.slice(0, MAX_INCIDENT_WINDOWS).map((s) => formatWindow(s.from, s.to, now));
}

export function incidentQueryWindow(anchorUtc: string, nowIso: string): IncidentQueryWindow | undefined {
	return incidentQueryWindows([anchorUtc], nowIso)[0];
}

function formatWindow(from: number, to: number, now: number): IncidentQueryWindow {
	// Round the relative start OUT (ceil) and the end OUT (floor), so the relative form
	// never excludes a second the absolute form includes.
	const minutesAgo = (ms: number, round: (n: number) => number) => Math.max(0, round((now - ms) / 60_000));
	const toMinutes = minutesAgo(to, Math.floor);
	return {
		fromIso: new Date(from).toISOString(),
		toIso: new Date(to).toISOString(),
		fromEpochSeconds: Math.floor(from / 1000),
		toEpochSeconds: Math.ceil(to / 1000),
		fromRelative: `now-${minutesAgo(from, Math.ceil)}m`,
		toRelative: toMinutes === 0 ? "now" : `now-${toMinutes}m`,
	};
}

// What the normalizer does with a parsed incident: an explicit timestamp in the query
// decides the window, in code. The model's own window survives only when the query names
// no absolute time (a relative phrase like "last 30 min" is still the model's to read).
// Pure, so the rule is tested without an LLM in the loop.
export function applyIncidentAnchors(
	incident: NormalizedIncident,
	query: string,
	timeZone: string | undefined,
	now: Date,
): NormalizedIncident {
	const anchors = extractIncidentAnchors(query, timeZone);
	if (anchors.length === 0) return incident;
	const anchored = investigationWindowFor(anchors, now);
	return { ...incident, incidentAnchors: anchors, ...(anchored && { timeWindow: anchored }) };
}

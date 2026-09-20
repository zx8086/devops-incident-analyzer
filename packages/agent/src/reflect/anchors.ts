// packages/agent/src/reflect/anchors.ts
//
// SIO-1834 (A4): signals that only exist ACROSS sessions. Pure functions over scans.
//
// Cross-session retry is the one quality anchor that works on this repo's traffic: the
// window is overwhelmingly single-turn (1 of 35 sessions had a follow-up), so every
// within-session reaction detector is starved, but a user who re-asks in a NEW session
// still leaves a trace. A later session opening with most of an earlier one's request says
// the earlier session fell short.
import type { Scan } from "./schema.ts";

export const RETRY_MIN_OVERLAP = 0.5;
export const RETRY_MAX_GAP_HOURS = 48;
const SHINGLE_SIZE = 3;

// An opener repeated verbatim across this many sessions is a template (a scheduled probe, a
// canned demo query), not a person re-asking. Excluded, or a cron job looks like a defect.
const TEMPLATE_MIN_SESSIONS = 3;
const TEMPLATE_PREFIX_CHARS = 60;

export function shingles(text: string, size = SHINGLE_SIZE): Set<string> {
	const words = String(text ?? "")
		.toLowerCase()
		.replace(/https?:\/\/\S+/g, " ")
		.replace(/[^\p{L}\p{N}\s]/gu, " ")
		.split(/\s+/)
		.filter(Boolean);
	const grams = new Set<string>();
	for (let i = 0; i + size <= words.length; i += 1) grams.add(words.slice(i, i + size).join(" "));
	return grams;
}

// Measured against the SHORTER text: a follow-up that restates the request and adds detail
// should still count as a retry of it.
export function overlap(a: Set<string>, b: Set<string>): number {
	if (!a.size || !b.size) return 0;
	const [small, large] = a.size <= b.size ? [a, b] : [b, a];
	let hits = 0;
	for (const gram of small) if (large.has(gram)) hits += 1;
	return hits / small.size;
}

export interface Retry {
	earlier: string;
	later: string;
	hours: number;
	overlap: number;
	excerpt: string;
}

export function findRetries(scans: Scan[]): Retry[] {
	// Headless runs replay a fixed dataset, so every eval would "retry" every other eval.
	const usable = scans
		.filter((scan) => !scan.source.headless && scan.request && scan.source.created)
		.map((scan) => ({
			id: scan.source.id,
			at: new Date(scan.source.created as string).getTime(),
			text: (scan.request as { text: string }).text,
		}))
		.filter((entry) => Number.isFinite(entry.at))
		.sort((a, b) => a.at - b.at);

	const templateCounts = new Map<string, number>();
	for (const entry of usable) {
		const prefix = entry.text.slice(0, TEMPLATE_PREFIX_CHARS).toLowerCase();
		templateCounts.set(prefix, (templateCounts.get(prefix) ?? 0) + 1);
	}

	const grams = new Map<string, Set<string>>();
	for (const entry of usable) grams.set(entry.id, shingles(entry.text));

	const retries: Retry[] = [];
	for (let i = 0; i < usable.length; i += 1) {
		for (let j = i + 1; j < usable.length; j += 1) {
			const earlier = usable[i];
			const later = usable[j];
			if (!earlier || !later) continue;

			const hours = (later.at - earlier.at) / 3600_000;
			if (hours > RETRY_MAX_GAP_HOURS) break; // sorted, so every later j is further away

			const prefix = later.text.slice(0, TEMPLATE_PREFIX_CHARS).toLowerCase();
			if ((templateCounts.get(prefix) ?? 0) >= TEMPLATE_MIN_SESSIONS) continue;

			const score = overlap(grams.get(earlier.id) ?? new Set(), grams.get(later.id) ?? new Set());
			if (score < RETRY_MIN_OVERLAP) continue;

			retries.push({
				earlier: earlier.id,
				later: later.id,
				hours: Number(hours.toFixed(2)),
				overlap: Number(score.toFixed(2)),
				excerpt: later.text,
			});
		}
	}
	return retries;
}

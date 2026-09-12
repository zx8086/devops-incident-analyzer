// scripts/monitor/report.ts
import { z } from "zod";

export const SeveritySchema = z.enum(["info", "warn", "critical"]);
export type Severity = z.infer<typeof SeveritySchema>;
export const FamilySchema = z.enum([
	"alarm",
	"logs",
	"drift",
	"cost",
	"identity",
	"ingestion",
	"trail",
	"cert",
	"watchlist",
]);
export type Family = z.infer<typeof FamilySchema>;

export const FindingSchema = z.object({
	family: FamilySchema,
	severity: SeveritySchema,
	resource: z.string(),
	summary: z.string(),
	dedup_key: z.string(),
	evidence: z.unknown(),
	at: z.string(),
});
export type Finding = z.infer<typeof FindingSchema>;

export const DiagnosisSchema = z.object({
	probable_cause: z.string(),
	affected_resources: z.array(z.string()),
	suggested_action: z.string(),
});
export type Diagnosis = z.infer<typeof DiagnosisSchema>;

// JSON schema handed to the Pi agent via coms response_schema.
export const DIAGNOSIS_RESPONSE_SCHEMA = {
	type: "object",
	required: ["diagnoses"],
	properties: {
		diagnoses: {
			type: "array",
			items: {
				type: "object",
				required: ["dedup_key", "probable_cause", "affected_resources", "suggested_action"],
				properties: {
					dedup_key: { type: "string" },
					probable_cause: { type: "string" },
					affected_resources: { type: "array", items: { type: "string" } },
					suggested_action: { type: "string" },
				},
			},
		},
	},
} as const;

const DiagnosesEnvelope = z.object({
	diagnoses: z.array(DiagnosisSchema.extend({ dedup_key: z.string() })),
});

export function parseDiagnoses(raw: unknown): Map<string, Diagnosis> | null {
	const parsed = DiagnosesEnvelope.safeParse(raw);
	if (!parsed.success) return null;
	const map = new Map<string, Diagnosis>();
	for (const d of parsed.data.diagnoses) {
		const { dedup_key, ...rest } = d;
		map.set(dedup_key, rest);
	}
	return map;
}

const SEV_ORDER: Record<Severity, number> = { critical: 0, warn: 1, info: 2 };
const NOTABLE_CAP = 10;

export function formatIncidentReport(
	accountId: string,
	// skipped: a per-finding reason it was left out of the investigation batch
	// (budget caps); it wins over the batch-wide investigationFailure.
	items: { finding: Finding; diagnosis: Diagnosis | null; skipped?: string }[],
	investigationFailure?: string | null,
	suppressedCount = 0,
): string {
	const sorted = [...items].sort((a, b) => SEV_ORDER[a.finding.severity] - SEV_ORDER[b.finding.severity]);
	const top = sorted[0]?.finding.severity ?? "info";
	const lines: string[] = [`[${top}] aws-${accountId}: ${sorted.length} finding(s)`, ""];
	for (const { finding, diagnosis, skipped } of sorted) {
		lines.push(`- (${finding.severity}/${finding.family}) ${finding.resource}: ${finding.summary}`);
		if (diagnosis) {
			lines.push(`  cause: ${diagnosis.probable_cause}`);
			if (diagnosis.affected_resources.length > 0) {
				lines.push(`  affected: ${diagnosis.affected_resources.join(", ")}`);
			}
			lines.push(`  action: ${diagnosis.suggested_action}`);
		} else if (finding.severity !== "info") {
			lines.push(`  (uninvestigated: ${skipped ?? investigationFailure ?? "agent unavailable or response invalid"})`);
		}
		lines.push(`  evidence: ${JSON.stringify(finding.evidence)}`);
	}
	if (suppressedCount > 0) {
		lines.push("", `suppressed: ${suppressedCount} finding(s) matching the ledger (journaled, not investigated)`);
	}
	return lines.join("\n");
}

export type DigestNotable = {
	severity: Severity;
	family: Family;
	resource: string;
	summary: string;
	uninvestigated: boolean;
	// How many journal rows collapsed into this entry (1 = a single occurrence).
	occurrences: number;
};

// A journaled finding row carries the finding plus the diagnosis it was (or
// wasn't) investigated with; a null diagnosis at warn+ is itself a signal.
// SIO-1698 follow-up: the digest's two counters, extracted from the monitor's
// buildDigest closure so they are testable and so they skip an unreadable row
// instead of throwing. The digest is the daily report of record -- one malformed
// journal row must not take the whole thing down. `skipped` is returned rather
// than swallowed: a partial digest that looks complete is the failure mode this
// guards against. Validating with FindingSchema rather than casting also keeps
// an absent `family` from becoming a count bucket keyed `undefined`.
export type JournalCounts = { counts: Record<string, number>; skipped: number };

export function findingCountsFromJournal(rows: { payload: string }[]): JournalCounts {
	const counts: Record<string, number> = {};
	let skipped = 0;
	for (const r of rows) {
		let payload: unknown;
		try {
			payload = JSON.parse(r.payload);
		} catch {
			skipped++;
			continue;
		}
		const parsed = FindingSchema.safeParse(payload);
		if (!parsed.success) {
			skipped++;
			continue;
		}
		counts[parsed.data.family] = (counts[parsed.data.family] ?? 0) + 1;
	}
	return { counts, skipped };
}

// check_error rows carry no schema of their own; an unnamed check is bucketed
// under "unknown" exactly as before, but a non-string `check` no longer
// stringifies into a bucket name like "[object Object]".
export function checkErrorCountsFromJournal(rows: { payload: string }[]): JournalCounts {
	const counts: Record<string, number> = {};
	let skipped = 0;
	for (const r of rows) {
		let payload: unknown;
		try {
			payload = JSON.parse(r.payload);
		} catch {
			skipped++;
			continue;
		}
		const raw = (payload as { check?: unknown }).check;
		const check = typeof raw === "string" && raw !== "" ? raw : "unknown";
		counts[check] = (counts[check] ?? 0) + 1;
	}
	return { counts, skipped };
}

// A flapping alarm journals one row per transition, so the same alarm can fill
// the whole notables section (observed live: 10 identical
// DatabaseServerCPUUtilization rows consumed all of NOTABLE_CAP and pushed 24
// other findings into "+N more in the journal"). Rows are collapsed on
// `dedup_key` -- the identity the checks already assign (`alarm:<name>:<state>`)
// -- so a recurring alarm reads as ONE finding with a count, and the cap is
// spent on distinct problems instead of repeats.
//
// The occurrence count is kept, not discarded: "entered ALARM (x10)" is a
// materially different signal from a single transition, and dropping it would
// hide a flap. Insertion order is preserved so the caller's sort still governs.
export function notablesFromJournal(rows: { payload: string }[]): DigestNotable[] {
	const byKey = new Map<string, DigestNotable>();
	for (const r of rows) {
		let payload: unknown;
		try {
			payload = JSON.parse(r.payload);
		} catch {
			continue;
		}
		const parsed = FindingSchema.safeParse(payload);
		if (!parsed.success || parsed.data.severity === "info") continue;
		const uninvestigated = (payload as { diagnosis?: unknown }).diagnosis == null;
		const existing = byKey.get(parsed.data.dedup_key);
		if (existing) {
			existing.occurrences++;
			// An uninvestigated occurrence outranks an investigated one: it is the
			// state that still needs somebody to look at it.
			if (uninvestigated) existing.uninvestigated = true;
			continue;
		}
		byKey.set(parsed.data.dedup_key, {
			severity: parsed.data.severity,
			family: parsed.data.family,
			resource: parsed.data.resource,
			summary: parsed.data.summary,
			uninvestigated,
			occurrences: 1,
		});
	}
	return [...byKey.values()];
}

export type SuppressionLedgerEntry = { pattern: string; reason: string; created_at: string };
export type SuppressionReviewEntry = SuppressionLedgerEntry & {
	matches: number;
	sampleKeys: string[];
};

const REVIEW_SAMPLE_CAP = 3;

export function suppressionReviewFromJournal(
	ledger: SuppressionLedgerEntry[],
	rows: { payload: string }[],
): SuppressionReviewEntry[] {
	const byPattern = new Map<string, { matches: number; sampleKeys: string[] }>();
	for (const e of ledger) byPattern.set(e.pattern, { matches: 0, sampleKeys: [] });
	for (const r of rows) {
		let payload: { suppressed_by?: unknown; dedup_key?: unknown };
		try {
			payload = JSON.parse(r.payload);
		} catch {
			continue;
		}
		const entry = typeof payload.suppressed_by === "string" ? byPattern.get(payload.suppressed_by) : undefined;
		if (!entry) continue;
		entry.matches++;
		const key = typeof payload.dedup_key === "string" ? payload.dedup_key : null;
		if (key && entry.sampleKeys.length < REVIEW_SAMPLE_CAP && !entry.sampleKeys.includes(key)) {
			entry.sampleKeys.push(key);
		}
	}
	return ledger.map((e) => ({ ...e, ...(byPattern.get(e.pattern) ?? { matches: 0, sampleKeys: [] }) }));
}

// The anti-masking counterweight to the ledger: what each suppression ate in
// the window, so accepted noise gets re-examined instead of forgotten.
export function formatSuppressionReview(input: {
	accountId: string;
	windowDays: number;
	entries: SuppressionReviewEntry[];
}): string {
	const lines = [`[info] aws-${input.accountId} suppression review (last ${input.windowDays}d)`, ""];
	if (input.entries.length === 0) {
		lines.push("suppression ledger is empty; nothing is being masked.");
		return lines.join("\n");
	}
	lines.push(`- ledger entries: ${input.entries.length}`);
	for (const e of input.entries) {
		lines.push(`- ${e.pattern} -- ${e.reason} (since ${e.created_at})`);
		if (e.matches === 0) {
			lines.push(`  no matches in ${input.windowDays}d; candidate for unsuppress`);
		} else {
			const samples = e.sampleKeys.length > 0 ? `, e.g. ${e.sampleKeys.join(", ")}` : "";
			lines.push(`  matches last ${input.windowDays}d: ${e.matches}${samples}`);
		}
	}
	return lines.join("\n");
}

export type DigestInput = {
	accountId: string;
	since: string;
	findingCounts: Record<string, number>;
	checkErrors: number;
	checkErrorsByCheck?: Record<string, number>;
	activeAlarms: string[];
	yesterdayUsd: number | null;
	baselineUsd: number | null;
	bundleVersion?: string | null;
	suppressedCount?: number;
	notables?: DigestNotable[];
	// Operator pause (SIO-1673): the digest still ships as the dead-man signal,
	// but it must say that the check cycles behind it were skipped.
	paused?: { reason: string; since: string } | null;
};

export function formatDigest(d: DigestInput): string {
	const total = Object.values(d.findingCounts).reduce((a, b) => a + b, 0);
	// A green digest produced while checks errored is a lie: degradation is
	// the headline, not a line item.
	// Pause and degradation are independent; both belong in the headline.
	const pausedNote = d.paused
		? `PAUSED: check cycles skipped since ${d.paused.since}${d.paused.reason ? ` (${d.paused.reason})` : ""}; send "resume" to the monitor`
		: "";
	const degradedNote = d.checkErrors > 0 ? `DEGRADED: ${d.checkErrors} check error(s) (since ${d.since})` : "";
	const notes = [pausedNote, degradedNote].filter(Boolean);
	const header =
		notes.length > 0
			? `[warn] aws-${d.accountId} daily digest ${notes.join("; ")}`
			: `[info] aws-${d.accountId} daily digest (since ${d.since})`;
	const lines: string[] = [header, ""];
	if (total === 0) {
		lines.push("- findings: no findings in the last 24h");
	} else {
		const parts = Object.entries(d.findingCounts)
			.map(([k, v]) => `${k}=${v}`)
			.join(" ");
		lines.push(`- findings: ${total} (${parts})`);
	}
	// Counts alone hide what actually needs follow-up: name every warn+
	// finding so the digest is reviewable without a journal round-trip.
	// Uninvestigated findings lead so they always survive the display cap: an
	// investigated critical already has its diagnosis in an incident report,
	// an uninvestigated warn has nobody looking at it (SIO-1623).
	const notables = (d.notables ?? [])
		.filter((n) => n.severity !== "info")
		.sort(
			(a, b) => Number(b.uninvestigated) - Number(a.uninvestigated) || SEV_ORDER[a.severity] - SEV_ORDER[b.severity],
		);
	if (notables.length > 0) {
		lines.push("- notable warn+ findings (last 24h):");
		for (const n of notables.slice(0, NOTABLE_CAP)) {
			const marker = n.uninvestigated ? " [uninvestigated]" : "";
			// A repeat count only when there IS a repeat, so the common
			// single-occurrence line is unchanged.
			const repeat = n.occurrences > 1 ? ` (x${n.occurrences})` : "";
			lines.push(`  - (${n.severity}/${n.family}) ${n.resource}: ${n.summary}${repeat}${marker}`);
		}
		if (notables.length > NOTABLE_CAP) {
			lines.push(`  - +${notables.length - NOTABLE_CAP} more warn+ finding(s) in the journal`);
		}
		const uninvestigated = notables.filter((n) => n.uninvestigated).length;
		if (uninvestigated > 0) lines.push(`- uninvestigated: ${uninvestigated}`);
	}
	// DEGRADED must be self-explanatory from the mailbox: name the failing
	// family, not just the count.
	const byCheck = Object.entries(d.checkErrorsByCheck ?? {});
	lines.push(
		byCheck.length > 0
			? `- check errors: ${d.checkErrors} (${byCheck.map(([k, v]) => `${k}=${v}`).join(" ")})`
			: `- check errors: ${d.checkErrors}`,
	);
	lines.push(
		d.activeAlarms.length === 0 ? "- alarms: none in ALARM" : `- alarms in ALARM: ${d.activeAlarms.join(", ")}`,
	);
	if (d.yesterdayUsd != null) {
		const base = d.baselineUsd != null ? ` vs 14d baseline $${d.baselineUsd.toFixed(2)}` : "";
		lines.push(`- spend yesterday: $${d.yesterdayUsd.toFixed(2)}${base}`);
	} else {
		lines.push("- spend: no cost data yet");
	}
	if ((d.suppressedCount ?? 0) > 0) lines.push(`- suppressed by ledger: ${d.suppressedCount}`);
	// Deploy canary: a stale bundle silently drops capabilities; the digest is
	// where the operator sees the version without an SSM round-trip.
	lines.push(`- bundle: ${d.bundleVersion ?? "unknown"}`);
	return lines.join("\n");
}

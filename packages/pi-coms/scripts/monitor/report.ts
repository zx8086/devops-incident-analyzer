// scripts/monitor/report.ts
import { z } from "zod";
import { formatFindingLine } from "../../contracts/report.ts";

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
	"health",
	"compliance",
	"guardduty",
	// SIO-1748: workload-state families. Unlike the families above, these read
	// continuous operational state rather than a config change or somebody
	// else's assertion of badness, so each carries its own discriminator.
	"targets",
	"tasks",
	"queues",
	"scaling",
	// SIO-1749: further failure assertions on reads already granted.
	"db-events",
	"stacks",
	// SIO-1750: families unlocked by the WorkloadStateReads IAM addition.
	"nodegroups",
	"quotas",
	// SIO-1681: the only family that reads the HUB rather than AWS. The monitor
	// has no model of its own, so it can still report a spoke whose model is
	// failing -- which is exactly when the spoke cannot report for itself.
	"spoke-health",
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

// A capped scan has to answer for what it did not report. Getting this wrong
// loses findings TWICE over: they are absent from the report, and then the
// progress marker (watermark or snapshot) advances past them so no later scan
// sees them either. It was got wrong independently in scaling, db-events and
// stacks, so the rule lives here rather than in each check:
//
//   if (omitted > 0) { findings.push(overflowFinding(...)); }   // hold progress
//   else             { advance the watermark / write the snapshot }
//
// The overflow row is info, so it never costs an investigation, and its dedup
// key carries the cycle minute so successive overflows do not collapse into
// one.
// The other half of the capped-scan rule, and the half that is easy to get
// subtly wrong: what the snapshot should contain afterwards. Dropping a
// resource the scan never reached makes it look NEW next cycle, so a stack
// that has been sitting in a failed state for a month reports as a fresh
// transition. Keyed on whether the scan stopped early -- NOT on whether
// anything reportable was left, which is a different question entirely.
export function snapshotAfterScan(
	prev: Record<string, string> | null,
	evaluated: Record<string, string>,
	truncated: boolean,
): Record<string, string> {
	return truncated ? { ...(prev ?? {}), ...evaluated } : evaluated;
}

export function overflowFinding(family: Family, omitted: number, cap: number, at: string): Finding {
	return {
		family,
		severity: "info",
		resource: `${family}:overflow`,
		summary: `${omitted} further ${family} finding(s) not reported this cycle (cap ${cap}); progress held so they are re-read next cycle`,
		dedup_key: `${family}:overflow:${at.slice(0, 16)}`,
		evidence: { omitted, cap },
		at,
	};
}

// SIO-1741: a diagnosis must cite at least one command it ran and what that
// command showed, and score its own confidence. A spoke once answered with a
// baseline ("5-46 events/hour, no zero hours") that CloudWatch contradicted;
// nothing in the contract had asked it to show its working. A reply without
// evidence fails validation and the finding ships uninvestigated, which is
// the honest state.
export const DiagnosisSchema = z.object({
	probable_cause: z.string(),
	affected_resources: z.array(z.string()),
	suggested_action: z.string(),
	evidence: z.array(z.object({ command: z.string().trim().min(1), observation: z.string().trim().min(1) })).min(1),
	confidence: z.number().min(0).max(1),
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
				required: ["dedup_key", "probable_cause", "affected_resources", "suggested_action", "evidence", "confidence"],
				properties: {
					dedup_key: { type: "string" },
					probable_cause: { type: "string" },
					affected_resources: { type: "array", items: { type: "string" } },
					suggested_action: { type: "string" },
					evidence: {
						type: "array",
						minItems: 1,
						description:
							"The commands actually run for this diagnosis and the one line of output that decides it; never a number the prompt did not carry or a command did not print",
						items: {
							type: "object",
							required: ["command", "observation"],
							properties: {
								command: { type: "string", minLength: 1 },
								observation: { type: "string", minLength: 1 },
							},
						},
					},
					confidence: {
						type: "number",
						minimum: 0,
						maximum: 1,
						description: "How well the cited evidence supports the probable cause",
					},
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

// SIO-1832: every header names the account the same way -- `aws-<id>` alone, or
// `aws-<id> (<name>)` when the host knows its friendly name. One helper so the
// four shapes cannot drift apart, and so the form stays the one
// contracts/report.ts parses.
function accountLabel(accountId: string, accountName?: string): string {
	return accountName ? `aws-${accountId} (${accountName})` : `aws-${accountId}`;
}

// The name reaches the monitor as an env var written by the bootstrap from
// Terraform's agent_name, so it is operator-supplied and must be treated as
// untrusted: anything outside the contract's charset would produce a header
// that parseMonitorHeader rejects outright, silently emptying the fleet inbox.
// Rejected rather than sanitised -- a mangled name in every subject is worse
// than no name.
//
// `aws-<id>` is dropped too: that is Terraform's own fallback when agent_name is
// empty, and repeating it would render as `aws-<id> (aws-<id>)`.
//
// The length cap is what keeps the WARNING readable, and is measured rather than
// guessed. The header reads `[warn] aws-<id> (<name>) daily digest DEGRADED:
// ...`, and SNS truncates the subject at 100 characters from the END, so a long
// name pushes the status keyword off the line: DEGRADED is lost at a 50-char
// name and PAUSED at 52, leaving an alarming email whose subject says only that
// a digest exists. 32 leaves both keywords intact with room to spare (the
// longest real fleet key, eu-shared-services-prd, is 22), and a longer name is
// TRUNCATED rather than dropped -- a shortened name still identifies the account,
// while no name at all sends the operator back to memorising ids.
const ACCOUNT_NAME_OK = /^[a-z0-9-]+$/;
const ACCOUNT_NAME_MAX = 32;

export function accountNameFromEnv(value: string | undefined, accountId: string): string | undefined {
	const name = (value ?? "").trim();
	if (name === "" || name === `aws-${accountId}`) return undefined;
	if (!ACCOUNT_NAME_OK.test(name)) return undefined;
	// Trailing hyphens would otherwise survive the cut and read as a typo.
	return name.length <= ACCOUNT_NAME_MAX ? name : name.slice(0, ACCOUNT_NAME_MAX).replace(/-+$/, "");
}

// SIO-1832: a finding summary is wrapped onto its own indented line(s) instead
// of being truncated mid-token on the resource line. Wrapped on whitespace so a
// Java FQN or a log group path stays readable; a single token longer than the
// width is left over-long rather than cut, because half an exception class name
// is worse than one wide line.
//
// Newlines are FOLDED first: the summary carries untrusted log text, and a raw
// newline would let one log event forge extra digest lines (the same reason
// summariseLogSample folds them at the source).
const SUMMARY_WRAP = 76;

function wrapSummary(summary: string, width = SUMMARY_WRAP): string[] {
	const flat = summary.replace(/\s+/g, " ").trim();
	if (flat === "") return [];
	const out: string[] = [];
	let line = "";
	for (const word of flat.split(" ")) {
		if (line === "") line = word;
		else if (line.length + 1 + word.length <= width) line += ` ${word}`;
		// A word that cannot fit on a line of its own would otherwise strand the
		// short word before it ("at" alone above a 120-char Java frame). Keep them
		// together and let the line run long -- it was going to run long anyway.
		else if (word.length > width) line += ` ${word}`;
		else {
			out.push(line);
			line = word;
		}
	}
	if (line !== "") out.push(line);
	return out;
}

export function formatIncidentReport(
	accountId: string,
	// skipped: a per-finding reason it was left out of the investigation batch
	// (budget caps, cooldown); it wins over the batch-wide investigationFailure.
	// reusedFrom: the diagnosis is an earlier turn's answer for the same
	// dedup_key, not a fresh one (SIO-1739); the reader sees when it was made.
	items: { finding: Finding; diagnosis: Diagnosis | null; skipped?: string; reusedFrom?: string }[],
	investigationFailure?: string | null,
	suppressedCount = 0,
	accountName?: string,
): string {
	const sorted = [...items].sort((a, b) => SEV_ORDER[a.finding.severity] - SEV_ORDER[b.finding.severity]);
	const top = sorted[0]?.finding.severity ?? "info";
	const lines: string[] = [`[${top}] ${accountLabel(accountId, accountName)}: ${sorted.length} finding(s)`, ""];
	for (const { finding, diagnosis, skipped, reusedFrom } of sorted) {
		lines.push(formatFindingLine(finding));
		if (diagnosis) {
			lines.push(`  cause: ${diagnosis.probable_cause}`);
			if (diagnosis.affected_resources.length > 0) {
				lines.push(`  affected: ${diagnosis.affected_resources.join(", ")}`);
			}
			lines.push(`  action: ${diagnosis.suggested_action}`);
			// The first citation is what lets a reader check the cause without
			// re-running the investigation; the rest stay in the journal.
			const cited = diagnosis.evidence[0];
			lines.push(`  cited: ${cited.command} => ${cited.observation} (confidence ${diagnosis.confidence.toFixed(2)})`);
			if (reusedFrom) lines.push(`  (diagnosis reused from ${reusedFrom}${skipped ? `; ${skipped}` : ""})`);
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
	accountName?: string;
	windowDays: number;
	entries: SuppressionReviewEntry[];
}): string {
	const lines = [
		`[info] ${accountLabel(input.accountId, input.accountName)} suppression review (last ${input.windowDays}d)`,
		"",
	];
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
	// SIO-1832: undefined on a host whose bootstrap predates the env var, so the
	// header falls back to the bare account id.
	accountName?: string;
	since: string;
	findingCounts: Record<string, number>;
	checkErrors: number;
	checkErrorsByCheck?: Record<string, number>;
	activeAlarms: string[];
	// SIO-1754: scaling-trigger alarms in ALARM, counted but not listed.
	scalingTriggersInAlarm?: number;
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
	const account = accountLabel(d.accountId, d.accountName);
	const header =
		notes.length > 0
			? `[warn] ${account} daily digest ${notes.join("; ")}`
			: `[info] ${account} daily digest (since ${d.since})`;
	const lines: string[] = [header, ""];
	// Counts alone hide what actually needs follow-up: name every warn+
	// finding so the digest is reviewable without a journal round-trip.
	// Uninvestigated findings lead so they always survive the display cap: an
	// investigated critical already has its diagnosis in an incident report,
	// an uninvestigated warn has nobody looking at it (SIO-1623).
	// The family is the last tiebreak, under uninvestigated and severity: one
	// cause usually produces one family (a Karpenter consolidation is a run of
	// compliance lines), so grouping them puts the repeated rule name in a block
	// the eye can skip rather than scattering it through the list. It cannot
	// disturb the two rules above it, which is why it sorts last.
	const notables = (d.notables ?? [])
		.filter((n) => n.severity !== "info")
		.sort(
			(a, b) =>
				Number(b.uninvestigated) - Number(a.uninvestigated) ||
				SEV_ORDER[a.severity] - SEV_ORDER[b.severity] ||
				a.family.localeCompare(b.family),
		);
	const uninvestigated = notables.filter((n) => n.uninvestigated).length;

	// SIO-1832: what decides whether to read on, before the detail. Same
	// `- label: value` shape as every other line so the web pane
	// (apps/web/src/lib/digest-emphasis.ts) still bolds the label.
	//
	// Only NON-ZERO attention items are named, and the line is omitted entirely
	// on a clean day: "0 uninvestigated, 0 check error(s)" is precisely the noise
	// a quiet digest must not carry, and a digest that reads quiet at a glance is
	// the point of the dead-man signal.
	const attention = [
		uninvestigated > 0 ? `${uninvestigated} uninvestigated` : "",
		d.checkErrors > 0 ? `${d.checkErrors} check error(s)` : "",
		(d.suppressedCount ?? 0) > 0 ? `${d.suppressedCount} suppressed` : "",
	].filter(Boolean);
	if (attention.length > 0) lines.push(`- needs attention: ${attention.join(", ")}`);
	if (total === 0) {
		lines.push("- findings: no findings in the last 24h");
	} else {
		const parts = Object.entries(d.findingCounts)
			.map(([k, v]) => `${k}=${v}`)
			.join(" ");
		lines.push(`- findings: ${total} (${parts})`);
	}
	const scaling = d.scalingTriggersInAlarm ?? 0;
	const scalingNote = scaling > 0 ? ` (${scaling} autoscaling trigger(s) in ALARM not listed)` : "";
	lines.push(
		d.activeAlarms.length === 0
			? `- alarms: none in ALARM${scalingNote}`
			: `- alarms in ALARM: ${d.activeAlarms.join(", ")}${scalingNote}`,
	);
	if (d.yesterdayUsd != null) {
		// A ratio is the thing an operator reacts to; "$2.18 vs $0.58" makes them
		// do the division. Guarded on a POSITIVE baseline: a zero or absent one
		// (a first-run account) would print Infinity.
		const base =
			d.baselineUsd != null && d.baselineUsd > 0
				? ` (${(d.yesterdayUsd / d.baselineUsd).toFixed(1)}x the 14d baseline of $${d.baselineUsd.toFixed(2)})`
				: d.baselineUsd != null
					? ` vs 14d baseline $${d.baselineUsd.toFixed(2)}`
					: "";
		lines.push(`- spend yesterday: $${d.yesterdayUsd.toFixed(2)}${base}`);
	} else {
		lines.push("- spend: no cost data yet");
	}

	if (notables.length > 0) {
		lines.push("", "- notable warn+ findings (last 24h):");
		// Consecutive entries sharing a resource print it once, so several
		// signatures from one log group read as one problem rather than several
		// unrelated ones. Display only: notablesFromJournal has already collapsed
		// on dedup_key, so those entries are genuinely distinct signatures and
		// each keeps its own line. The cap counts ENTRIES, not printed lines.
		//
		// The repeat keeps the severity/family tag rather than a "same as above"
		// marker: the tag is what the web pane badges, and a reader scrolling a
		// long digest should not have to look upwards to identify a line.
		let lastResource: string | null = null;
		for (const [i, n] of notables.slice(0, NOTABLE_CAP).entries()) {
			// One blank line between entries so each resource plus its wrapped
			// summary reads as a block. A run of nine required-tags lines was a wall
			// of text otherwise. Not a heading: the digest is also parsed by
			// contracts/report.ts and re-styled by the web pane
			// (apps/web/src/lib/digest-emphasis.ts), which both key off the existing
			// line shapes -- a blank line adds no new shape for them to learn.
			if (i > 0) lines.push("");
			const marker = n.uninvestigated ? " [uninvestigated]" : "";
			// A repeat count only when there IS a repeat, so the common
			// single-occurrence line is unchanged.
			const repeat = n.occurrences > 1 ? ` (x${n.occurrences})` : "";
			const resource = n.resource === lastResource ? `${n.resource} (also)` : n.resource;
			lines.push(`  - (${n.severity}/${n.family}) ${resource}${repeat}${marker}`);
			lastResource = n.resource;
			// The message goes on its own indented line(s) rather than being
			// squeezed onto the resource line and cut mid-token.
			for (const line of wrapSummary(n.summary)) lines.push(`      ${line}`);
		}
		if (notables.length > NOTABLE_CAP) {
			lines.push("", `  - +${notables.length - NOTABLE_CAP} more warn+ finding(s) in the journal`);
		}
		// Blank line first: with entries now separated, a flush `- uninvestigated:`
		// would read as part of the last entry's block rather than as the summary
		// line for the whole list.
		if (uninvestigated > 0) lines.push("", `- uninvestigated: ${uninvestigated}`);
	}

	lines.push("");
	// DEGRADED must be self-explanatory from the mailbox: name the failing
	// family, not just the count.
	const byCheck = Object.entries(d.checkErrorsByCheck ?? {});
	lines.push(
		byCheck.length > 0
			? `- check errors: ${d.checkErrors} (${byCheck.map(([k, v]) => `${k}=${v}`).join(" ")})`
			: `- check errors: ${d.checkErrors}`,
	);
	if ((d.suppressedCount ?? 0) > 0) lines.push(`- suppressed by ledger: ${d.suppressedCount}`);
	// Deploy canary: a stale bundle silently drops capabilities; the digest is
	// where the operator sees the version without an SSM round-trip.
	lines.push(`- bundle: ${d.bundleVersion ?? "unknown"}`);
	return lines.join("\n");
}

// packages/agent/src/reflect/aggregate.ts
//
// SIO-1834 (A4): many scans -> ranked findings + portfolio moves. Pure, no I/O, no LLM.
//
// Recurrence, not volume: a group ranks by how many DISTINCT sessions it appears in. One
// session is a hypothesis; the same gap in three is a defect. A single session that failed
// ten times is still one session.
import { z } from "zod";
import type { Scan, Severity, SignalKind } from "./schema.ts";
import { EvidenceSchema, SeveritySchema, SignalKindSchema } from "./schema.ts";

export const ANALYSIS_SCHEMA_ID = "devops-skill-reflection/1";

// Act only on a gap seen in at least two sessions (rule R3).
export const MIN_RECURRENCE = 2;

// Kinds that are never a gap, so never a finding. expected-outcome is a normal discovery
// result (agent-state.ts:20-24), not a malfunction.
const NON_GAP_KINDS: readonly SignalKind[] = ["expected-outcome"];

// What kind of change each signal argues for. These are hints for the human who reads the
// report, not verdicts -- the script finds, the judge decides.
export const CLASS_BY_KIND: Record<SignalKind, string> = {
	"tool-failure": "doc-command-drift",
	"repeat-call": "missing-check",
	"user-correction": "missing-gate",
	"user-reprompt": "stopping-point",
	"user-redo": "missing-expectation",
	"user-handoff": "missing-expectation",
	"user-abandon": "missing-expectation",
	"expected-outcome": "none",
};

const CHANGE_BY_CLASS: Record<string, string> = {
	"doc-command-drift": "the call this datasource's prose documents no longer matches the tool; fix the documented call",
	"missing-check": "add a check that makes the redundant second call unnecessary",
	"missing-gate": "add a gate that catches this before the user has to correct it",
	"stopping-point": "say where the work should stop, so the user does not have to re-prompt",
	"missing-expectation": "state the expectation the reply did not meet",
	none: "",
};

const SEVERITY_RANK: Record<Severity, number> = { high: 3, medium: 2, low: 1 };

export const FindingSchema = z.object({
	id: z.string().regex(/^F\d+$/),
	kind: SignalKindSchema,
	class: z.string(),
	datasource: z.string().nullable().describe("the owning datasource, or null when no datasource owns it"),
	severity: SeveritySchema,
	recurrence: z.number().describe("distinct sessions; the ranking key"),
	count: z.number().describe("total occurrences across those sessions"),
	summary: z.string(),
	change: z.string(),
	sessions: z.array(z.string()),
	evidence: z.array(EvidenceSchema.extend({ session: z.string() })).max(3),
});
export type Finding = z.infer<typeof FindingSchema>;

export const PortfolioItemSchema = z.object({
	id: z.string().regex(/^PF\d+$/),
	action: z.enum(["create", "merge", "split", "delete"]),
	datasources: z.array(z.string()),
	reason: z.string(),
	recurrence: z.number(),
	evidence: z.array(EvidenceSchema.extend({ session: z.string() })).max(3),
});
export type PortfolioItem = z.infer<typeof PortfolioItemSchema>;

export const AnalysisSchema = z.object({
	schema: z.literal(ANALYSIS_SCHEMA_ID),
	generatedAt: z.string(),
	window: z.object({ hours: z.number(), since: z.string(), until: z.string() }),
	stats: z.object({
		sessions: z.number(),
		headless: z.number(),
		signals: z.number(),
		high: z.number(),
		findings: z.number(),
		portfolio: z.number(),
		multiTurnSessions: z.number().describe("sessions with >1 user turn; 0 means no reaction detector could fire"),
	}),
	datasources: z.array(
		z.object({
			name: z.string(),
			sessions: z.number(),
			high: z.number(),
			medium: z.number(),
			low: z.number(),
		}),
	),
	findings: z.array(FindingSchema),
	retries: z.array(
		z.object({ earlier: z.string(), later: z.string(), hours: z.number(), overlap: z.number(), excerpt: z.string() }),
	),
	portfolio: z.array(PortfolioItemSchema),
	notes: z.array(z.string()),
});
export type Analysis = z.infer<typeof AnalysisSchema>;

interface Group {
	kind: SignalKind;
	datasource: string | null;
	sessions: Set<string>;
	count: number;
	severity: Severity;
	summary: string;
	evidence: Array<{ session: string; message: number; tool: string | null; excerpt: string }>;
}

export function aggregate(scans: Scan[], options: { hours: number; now?: Date }): Analysis {
	const now = options.now ?? new Date();
	const groups = new Map<string, Group>();
	const perDatasource = new Map<string, { sessions: Set<string>; high: number; medium: number; low: number }>();
	let signalCount = 0;
	let highCount = 0;

	for (const scan of scans) {
		for (const signal of scan.signals) {
			signalCount += 1;
			if (signal.severity === "high") highCount += 1;

			// One suspect means one owner. SEVERAL means the turn as a whole is implicated --
			// a user reacted to the answer, not to a datasource -- so there is no owner, and
			// picking suspects[0] would point remediation at whichever datasource happened to
			// sort first (the tag is sorted at langsmith-tags.ts:13, so it would at least be
			// stable, but stably wrong). A turn-wide finding says that honestly by owning
			// nothing, and the evidence still names the run to open.
			const datasource = signal.suspects.length === 1 ? (signal.suspects[0] ?? null) : null;
			if (datasource) {
				const entry = perDatasource.get(datasource) ?? { sessions: new Set(), high: 0, medium: 0, low: 0 };
				entry.sessions.add(scan.source.id);
				entry[signal.severity] += 1;
				perDatasource.set(datasource, entry);
			}

			if (NON_GAP_KINDS.includes(signal.kind)) continue;

			const key = `${signal.kind}|${datasource ?? "-"}`;
			const group = groups.get(key) ?? {
				kind: signal.kind,
				datasource,
				sessions: new Set<string>(),
				count: 0,
				severity: signal.severity,
				summary: signal.summary,
				evidence: [],
			};
			group.sessions.add(scan.source.id);
			group.count += signal.count;
			if (SEVERITY_RANK[signal.severity] > SEVERITY_RANK[group.severity]) {
				group.severity = signal.severity;
				group.summary = signal.summary;
			}
			// At most ONE piece of evidence per session. A finding's job is to show the gap
			// recurring, so three quotes from the same run prove nothing the recurrence count
			// did not already say -- and leave a reader unable to check a second occurrence.
			if (!group.evidence.some((item) => item.session === scan.source.id)) {
				const first = signal.evidence[0];
				if (first) group.evidence.push({ session: scan.source.id, ...first });
			}
			groups.set(key, group);
		}
	}

	// Rank: recurrence first (R3), then severity, then volume. Stable on the key so a rerun
	// over the same window produces the same ids.
	const ranked = [...groups.entries()]
		.map(([key, group]) => ({ key, group }))
		.sort((a, b) => {
			const recurrence = b.group.sessions.size - a.group.sessions.size;
			if (recurrence !== 0) return recurrence;
			const severity = SEVERITY_RANK[b.group.severity] - SEVERITY_RANK[a.group.severity];
			if (severity !== 0) return severity;
			if (b.group.count !== a.group.count) return b.group.count - a.group.count;
			return a.key.localeCompare(b.key);
		});

	const findings: Finding[] = [];
	const portfolio: PortfolioItem[] = [];

	for (const { group } of ranked) {
		const recurrence = group.sessions.size;
		if (recurrence < MIN_RECURRENCE) continue;

		const cls = CLASS_BY_KIND[group.kind];
		findings.push({
			id: `F${findings.length + 1}`,
			kind: group.kind,
			class: cls,
			datasource: group.datasource,
			severity: group.severity,
			recurrence,
			count: group.count,
			summary: group.summary,
			change: CHANGE_BY_CLASS[cls] ?? "",
			sessions: [...group.sessions].sort(),
			evidence: group.evidence.slice(0, 3),
		});

		// A recurring failure that names NO datasource is a gap nothing owns -- the
		// create-a-skill candidate. The source rule keys on an unattributed SKILL; this repo
		// has no per-turn skill signal (see scan.ts), so an unattributed DATASOURCE is the
		// nearest honest equivalent: a tool whose name matched no known server prefix.
		if (!group.datasource && group.kind === "tool-failure") {
			portfolio.push({
				id: `PF${portfolio.length + 1}`,
				action: "create",
				datasources: [],
				reason: `recurring ${group.kind} names no datasource, so nothing owns this gap`,
				recurrence,
				evidence: group.evidence.slice(0, 3),
			});
		}
	}

	// D5: no delete rule. It needs a signal saying a skill was loaded and NOT used, and
	// skillsApplied reports every declared skill rather than the ones a turn used
	// (prompt-context.ts:206-212), so "unused" would always be empty. Not ported.

	const multiTurn = scans.filter((s) => s.stats.userMessages > 1).length;
	const notes: string[] = [];
	if (scans.length > 0 && multiTurn === 0) {
		// Say it in the report rather than letting an empty quality lane read as "no quality
		// problems". Measured on a real 7-day window: 1 of 35 sessions was multi-turn.
		notes.push(
			"No session in this window had more than one user turn, so no user-reaction detector could fire. " +
				"The absence of user-redo/handoff/correction findings is not evidence that none exist.",
		);
	}

	return {
		schema: ANALYSIS_SCHEMA_ID,
		generatedAt: now.toISOString(),
		window: {
			hours: options.hours,
			since: new Date(now.getTime() - options.hours * 3600_000).toISOString(),
			until: now.toISOString(),
		},
		stats: {
			sessions: scans.length,
			headless: scans.filter((s) => s.source.headless).length,
			signals: signalCount,
			high: highCount,
			findings: findings.length,
			portfolio: portfolio.length,
			multiTurnSessions: multiTurn,
		},
		datasources: [...perDatasource.entries()]
			.map(([name, v]) => ({ name, sessions: v.sessions.size, high: v.high, medium: v.medium, low: v.low }))
			.sort((a, b) => b.sessions - a.sessions || a.name.localeCompare(b.name)),
		findings,
		retries: [],
		portfolio,
		notes,
	};
}

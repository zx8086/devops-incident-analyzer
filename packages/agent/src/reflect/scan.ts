// packages/agent/src/reflect/scan.ts
//
// SIO-1834 (A3): one normalized session -> signals. Deterministic, no LLM.
//
// The script finds, a human decides. Severity here is mechanical: "high" means a failing
// call named a datasource or the user reacted to a reply, never "this datasource is at
// fault". Every signal carries a message index and an excerpt, so a proposal can quote
// rather than assert.
import type {
	Evidence,
	NormalizedMessage,
	NormalizedSession,
	Scan,
	ScanStats,
	Severity,
	Signal,
	SignalKind,
} from "./schema.ts";
import { verdictForCategory } from "./schema.ts";

const EXCERPT_CHARS = 160;
const MAX_EVIDENCE = 3;
const MIN_REQUEST_WORDS = 8;

// Tuned on another author's sessions in the xskills source; treat every match as a lead to
// verify, not a verdict (SIO-1834 risk table). Re-measure before letting these rank anything.
// The delimiter accepts terminal punctuation, not just a comma or space: "Wrong. Use the
// other index", "No! Use production" and "Stop; use staging" are corrections too, and the
// comma-only form missed all three.
const CORRECTION_RE =
	/^(no|nope|wrong|not quite|actually|i said|i meant|that's not|thats not|stop|don't|dont|again|still)\b[,.!;:?\s-]/i;
const REPROMPT_RE = /^(continue|go on|try again|retry|proceed|keep going|next|again)\b[.!]?$/i;
const REDO_RE =
	/\b(once again|another (full )?(round|pass|go)|one more time|re-?do|start over|from scratch|do it (again|properly|right)|again check|check again)\b/i;
const HANDOFF_RE =
	/\b(another agent|other agent|pass it to|hand (it )?off|as (an? )?(llm )?prompt|i'?ll do it myself|i will do it myself|never ?mind|forget it|i give up)\b/i;

// A host injects text into the user role (system reminders, interrupt notices). Those are not
// the user's words and must not trigger a reaction detector.
const INJECTED_RE = /^(\[Request interrupted|<system-reminder|Caveat: The messages below)/;

function excerpt(text: string): string {
	return String(text ?? "")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, EXCERPT_CHARS);
}

// A tool_call's input is {args, result:<hash>}; only the args are meaningful to a reader,
// and the hash would be noise in a report.
function argsExcerpt(input: string): string {
	try {
		const parsed: unknown = JSON.parse(input);
		if (parsed && typeof parsed === "object" && "args" in parsed) {
			return excerpt(JSON.stringify((parsed as { args: unknown }).args));
		}
	} catch {
		// A non-JSON input (another adapter, a hand-built fixture) is shown as-is.
	}
	return excerpt(input);
}

function textOf(message: NormalizedMessage): string {
	return message.parts
		.filter((part) => part.type === "text")
		.map((part) => (part.type === "text" ? part.text : ""))
		.join("\n")
		.trim();
}

// The user's own turns, in their own words.
function userTurns(session: NormalizedSession): { message: NormalizedMessage; text: string }[] {
	return session.messages
		.filter((message) => message.role === "user")
		.map((message) => ({ message, text: textOf(message) }))
		.filter(({ text }) => text.length > 0 && !INJECTED_RE.test(text));
}

// The datasource a tool call belongs to. Tool names are prefixed per server
// (aws_logs_start_query, elasticsearch_search, gitlab_get_merge_request), which the SIO-1834
// probe confirmed on every run_type=tool child. This is the only per-turn attribution the
// trace actually carries; skillsApplied names every declared skill, so it attributes nothing.
const DATASOURCE_BY_PREFIX: Record<string, string> = {
	aws: "aws",
	elasticsearch: "elastic",
	kafka: "kafka",
	ksql: "kafka",
	sr: "kafka",
	capella: "couchbase",
	konnect: "konnect",
	gitlab: "gitlab",
	atlassian: "atlassian",
};

export function datasourceForTool(toolName: string | null | undefined): string | null {
	if (!toolName) return null;
	const prefix = String(toolName).split("_")[0]?.toLowerCase() ?? "";
	return DATASOURCE_BY_PREFIX[prefix] ?? null;
}

interface Draft {
	kind: SignalKind;
	severity: Severity;
	summary: string;
	count: number;
	suspects: string[];
	evidence: Evidence[];
}

export function scanSession(session: NormalizedSession): Scan {
	const drafts: Draft[] = [];
	const notes: string[] = [];
	const stats: ScanStats = {
		messages: session.messages.length,
		userMessages: 0,
		assistantMessages: 0,
		toolCalls: 0,
		toolResults: 0,
		toolFailures: 0,
		expectedOutcomes: 0,
		environmentFailures: 0,
		repeats: 0,
		corrections: 0,
		reprompts: 0,
		redoRequests: 0,
		handoffs: 0,
	};

	for (const message of session.messages) {
		if (message.role === "user") stats.userMessages += 1;
		else stats.assistantMessages += 1;
	}

	// --- Tool failures, split by what the category actually indicts -------------------
	const failures = new Map<string, { evidence: Evidence[]; count: number; datasource: string | null }>();
	const expected: Evidence[] = [];

	for (const message of session.messages) {
		for (const part of message.parts) {
			if (part.type === "tool_call") stats.toolCalls += 1;
			if (part.type !== "tool_result") continue;
			stats.toolResults += 1;
			if (!part.failed) continue;

			const verdict = verdictForCategory(part.category);
			if (verdict === "expected") {
				stats.expectedOutcomes += 1;
				if (expected.length < MAX_EVIDENCE) {
					expected.push({ message: message.index, tool: part.name, excerpt: excerpt(part.content) });
				}
				continue;
			}
			if (verdict === "environment") {
				// Counted so a report can say "this window was noisy for infra reasons",
				// but never a finding: the skill cannot fix an expired token.
				stats.environmentFailures += 1;
				continue;
			}

			stats.toolFailures += 1;
			const datasource = datasourceForTool(part.name);
			const key = `${datasource ?? "-"}:${part.category ?? "unknown"}`;
			const entry = failures.get(key) ?? { evidence: [], count: 0, datasource };
			entry.count += 1;
			if (entry.evidence.length < MAX_EVIDENCE) {
				entry.evidence.push({ message: message.index, tool: part.name, excerpt: excerpt(part.content) });
			}
			failures.set(key, entry);
		}
	}

	for (const [key, entry] of failures) {
		const category = key.split(":")[1] ?? "unknown";
		drafts.push({
			kind: "tool-failure",
			// A failure that names a datasource is actionable; one that names none is a
			// candidate gap that no datasource owns, which is weaker on its own.
			severity: entry.datasource ? "high" : entry.count > 1 ? "medium" : "low",
			summary: `${entry.count} ${category} failure(s) on ${entry.datasource ?? "an unattributed tool"}`,
			count: entry.count,
			suspects: entry.datasource ? [entry.datasource] : [],
			evidence: entry.evidence,
		});
	}

	if (expected.length) {
		drafts.push({
			kind: "expected-outcome",
			severity: "low",
			summary: `${stats.expectedOutcomes} expected not-found/no-data outcome(s)`,
			count: stats.expectedOutcomes,
			suspects: [],
			evidence: expected,
		});
	}

	// --- Repeated identical calls ------------------------------------------------------
	// Scoped PER MESSAGE, because the adapter emits one message per sub-agent dispatch. The
	// same call issued by two dispatches of the same datasource is ordinary fan-out (an
	// estate loop, a per-deployment sweep), not a loop worth reporting; only a repeat
	// WITHIN one dispatch is. Keying across the whole session reported 78% of calls as
	// repeats on a real window.
	const calls = new Map<string, { count: number; evidence: Evidence[]; name: string }>();
	let unprovableRepeats = 0;
	for (const message of session.messages) {
		for (const part of message.parts) {
			if (part.type !== "tool_call") continue;
			// SIO-1856: a repeat is only PROVABLE when the recorded args identify the call.
			// For a tool whose real input is a nested object (a search body, a filter), the
			// args record nothing that distinguishes two calls, so "identical" means "we
			// cannot see the difference" -- not "there was none". Counted, never reported:
			// acting on it would mean caching two genuinely different searches together.
			if (!part.argsIdentifyTheCall) {
				unprovableRepeats += 1;
				continue;
			}
			// Keyed on the PRE-redaction digest, not the redacted text: redaction collapses
			// every email onto one placeholder, so two calls for different users would
			// otherwise be byte-identical here (SIO-1856, found in review).
			const identity = "inputDigest" in part ? part.inputDigest : part.input;
			const key = `${message.index}\x1f${part.name}\x1f${identity}`;
			const entry = calls.get(key) ?? { count: 0, evidence: [], name: part.name };
			entry.count += 1;
			if (entry.evidence.length < MAX_EVIDENCE) {
				entry.evidence.push({ message: message.index, tool: part.name, excerpt: argsExcerpt(part.input) });
			}
			calls.set(key, entry);
		}
	}
	for (const entry of calls.values()) {
		if (entry.count < 2) continue;
		stats.repeats += entry.count - 1;
		drafts.push({
			kind: "repeat-call",
			severity: entry.count > 2 ? "medium" : "low",
			summary: `${entry.name} called ${entry.count}x with identical input`,
			count: entry.count,
			suspects: [datasourceForTool(entry.name)].filter((d): d is string => d !== null),
			evidence: entry.evidence,
		});
	}

	// --- User reactions ----------------------------------------------------------------
	const turns = userTurns(session);
	const request = turns.find(({ text }) => text.split(/\s+/).length >= MIN_REQUEST_WORDS) ?? null;

	// Headless runs have no user to react, and a replay's scripted prompts would otherwise
	// read as corrections.
	if (!session.source.headless) {
		// Reactions are read only AFTER the opening turn: a run that OPENS by re-asking
		// earlier work is not that run's own failure. That case is a cross-session retry,
		// which anchors.ts detects across runs.
		//
		// The boundary is the FIRST user turn, not `request`. `request` requires
		// MIN_REQUEST_WORDS because it is the handle for cross-run matching, where a short
		// opener produces meaningless overlap. A shorter opener is still the opener, so
		// anchoring on `request` would let a brief "redo it from scratch" first turn blame
		// this run for work a previous one failed at.
		//
		// NOTE: the adapter keeps only the turn a run introduced, so today a LangSmith run
		// has exactly one user turn and nothing survives this filter -- the within-run
		// reaction lane is inert on that source, and cross-session retry carries the signal
		// instead. The lane stays because it is source-agnostic: a transcript source with
		// genuine multi-turn sessions feeds it directly.
		const opening = turns[0];
		const afterOpening = opening ? turns.filter(({ message }) => message.index > opening.message.index) : turns;

		const reactions: {
			kind: SignalKind;
			re: RegExp;
			severity: Severity;
			stat: "corrections" | "redoRequests" | "handoffs";
			words: number;
		}[] = [
			{ kind: "user-correction", re: CORRECTION_RE, severity: "high", stat: "corrections", words: 2 },
			{ kind: "user-redo", re: REDO_RE, severity: "high", stat: "redoRequests", words: 3 },
			{ kind: "user-handoff", re: HANDOFF_RE, severity: "high", stat: "handoffs", words: 3 },
		];

		for (const reaction of reactions) {
			const hits = afterOpening.filter(
				({ text }) => reaction.re.test(text) && text.split(/\s+/).length > reaction.words,
			);
			if (!hits.length) continue;
			stats[reaction.stat] = hits.length;
			drafts.push({
				kind: reaction.kind,
				severity: reaction.severity,
				summary: `user ${reaction.kind.replace("user-", "")} x${hits.length}`,
				count: hits.length,
				// The session's datasources, not a skill: a reaction indicts the turn as a
				// whole, and the turn's datasources are the only owners the trace names.
				suspects: session.source.datasources,
				evidence: hits
					.slice(0, MAX_EVIDENCE)
					.map(({ message, text }) => ({ message: message.index, tool: null, excerpt: excerpt(text) })),
			});
		}

		const reprompts = afterOpening.filter(({ text }) => text.split(/\s+/).length <= 3 && REPROMPT_RE.test(text));
		if (reprompts.length) {
			stats.reprompts = reprompts.length;
			drafts.push({
				kind: "user-reprompt",
				severity: reprompts.length > 1 ? "medium" : "low",
				summary: `user re-prompted x${reprompts.length}`,
				count: reprompts.length,
				suspects: session.source.datasources,
				evidence: reprompts
					.slice(0, MAX_EVIDENCE)
					.map(({ message, text }) => ({ message: message.index, tool: null, excerpt: excerpt(text) })),
			});
		}
	} else {
		notes.push("headless run: user-reaction detectors skipped");
	}

	// Say what could not be measured. Silently dropping these would let a window full of
	// unverifiable repeats read as a window with none.
	if (unprovableRepeats > 0) {
		notes.push(
			`${unprovableRepeats} tool call(s) skipped for repeat detection: their recorded arguments cannot identify the call (SIO-1856)`,
		);
	}

	const signals: Signal[] = drafts.map((draft, index) => ({ id: `S${index + 1}`, ...draft }));

	return {
		source: session.source,
		request: request
			? { message: request.message.index, created: request.message.created, text: excerpt(request.text) }
			: null,
		stats,
		signals,
		notes,
	};
}

// scripts/monitor/actionability.ts
// SIO-1838: ask whether a finding is worth a full model turn before spending one.
//
// Today the entire decision is `severity !== "info" && family !== "spoke-health"`
// in coms-net-monitor.ts. Everything after it counts rather than judges: reuse on
// an exact dedup_key, a 24-prompt daily cap, a per-resource cap. Measured cost of
// having no judgement: one account produced 72 warn/logs findings on a single log
// group in a day and its agent reached 98% context; one flapping low-CPU alarm
// spent three turns in a day; one Karpenter consolidation was 51 findings.
//
// This is a third pass in the same shape as planInvestigation (budget.ts): pure,
// returns send + skipped-with-reason, and holds a finding back only on a
// CONFIDENT verdict. Two hard rules:
//
//   - SHADOW FIRST. SIO-1748..1752 removed an earlier shadow mechanism because it
//     held real incidents out of the inbox -- seven dead-letter queues and a
//     failed ECS deployment -- while catching one noise source that turned out to
//     be a severity bug. So this ships enforcing=false until a journal replay says
//     otherwise, and the verdict is journaled either way.
//   - NEVER for critical. A critical finding always reaches the agent; the gate
//     only ever considers warn.
//
// "Has it recovered?" is deliberately absent: that is a time comparison, and Jev
// compares dates unreliably (vendor-documented). It belongs in code.
import type { Finding } from "./report.ts";

// Probability at or above which a "routine" verdict holds a finding back. High on
// purpose: the cost of a wrong skip (a missed incident) is much larger than the
// cost of a wrong send (one model turn, already capped by the budget pass).
export const ROUTINE_SKIP_THRESHOLD = 0.85;

export interface ActionabilityVerdict {
	// P(this is routine expected operational noise rather than a problem).
	routine: number;
	// P(this describes the same failure as one of the recent findings supplied).
	duplicate: number;
}

export interface ActionabilityDecision {
	send: Finding[];
	skipped: { finding: Finding; reason: string }[];
	// What the gate WOULD have skipped while shadowing. Always populated, so a
	// journal replay can measure the gate without it changing anything.
	wouldSkip: { finding: Finding; reason: string }[];
}

function reasonFor(v: ActionabilityVerdict): string | undefined {
	if (v.routine >= ROUTINE_SKIP_THRESHOLD) {
		return `routine operational event (p=${v.routine.toFixed(2)})`;
	}
	if (v.duplicate >= ROUTINE_SKIP_THRESHOLD) {
		return `same failure as a recently diagnosed finding (p=${v.duplicate.toFixed(2)})`;
	}
	return undefined;
}

/**
 * Split findings into those worth a model turn and those not.
 *
 * `verdicts` is keyed by dedup_key. A finding with no verdict is SENT: a missing
 * judgement means the gate could not run, and the fallback is always today's
 * behaviour.
 *
 * With `enforcing: false` (the default while shadowing) every finding is sent and
 * the would-be skips are reported separately for the journal.
 */
export function planActionability(
	findings: Finding[],
	verdicts: Map<string, ActionabilityVerdict>,
	opts: { enforcing: boolean },
): ActionabilityDecision {
	const send: Finding[] = [];
	const skipped: { finding: Finding; reason: string }[] = [];
	const wouldSkip: { finding: Finding; reason: string }[] = [];

	for (const finding of findings) {
		// A critical finding is never gated. The whole point of the severity is
		// that somebody looks at it.
		if (finding.severity === "critical") {
			send.push(finding);
			continue;
		}
		const verdict = verdicts.get(finding.dedup_key);
		const reason = verdict ? reasonFor(verdict) : undefined;
		if (!reason) {
			send.push(finding);
			continue;
		}
		wouldSkip.push({ finding, reason });
		if (opts.enforcing) skipped.push({ finding, reason });
		else send.push(finding);
	}

	return { send, skipped, wouldSkip };
}

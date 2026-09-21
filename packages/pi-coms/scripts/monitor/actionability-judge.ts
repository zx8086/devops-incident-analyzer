// scripts/monitor/actionability-judge.ts
// SIO-1838: the Jev half of the actionability gate. Kept apart from
// actionability.ts so the decision logic stays pure and offline-testable, and
// only this file knows there is a network.

import type { ActionabilityVerdict } from "./actionability.ts";
import type { Finding } from "./report.ts";
import { askSystemOne, type NoulQuestion, resolveTypeSafeApiKey } from "./typesafe.ts";

// One deadline for the whole batch. A monitor cycle runs every 15 minutes and the
// findings are already collected; the gate must not become the reason a cycle
// overruns, so it gives up early and lets everything through.
export const JUDGE_DEADLINE_MS = 10_000;

// How many recently-diagnosed summaries the duplicate question compares against.
// Small on purpose: Jev loses accuracy as the state fills with material the
// question does not need, and the hard cap is 32k tokens for state + question.
const RECENT_CONTEXT = 8;

export function isActionabilityGateEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	const v = env.MONITOR_ACTIONABILITY_ENABLED?.toLowerCase();
	return v !== "false" && v !== "0";
}

// Also default ON: a gate that only observes is a gate that never does its job,
// and the whole point of the ticket is the 72-findings-in-a-day case. Set
// MONITOR_ACTIONABILITY_ENFORCING=false to fall back to judging and journaling
// without acting, which is the mode to use while reading the first days of
// `actionability_verdict` rows.
//
// What keeps this safe is not observation, it is the shape of the decision:
// a critical finding is never gated, a skip needs p >= 0.85, a missing or
// unconfident verdict sends, and any error sends the whole batch. Every one of
// those is mutation-checked in monitor-actionability.test.ts.
export function isActionabilityEnforcing(env: NodeJS.ProcessEnv = process.env): boolean {
	const v = env.MONITOR_ACTIONABILITY_ENFORCING?.toLowerCase();
	return v !== "false" && v !== "0";
}

const ROUTINE_Q = "routine";
const DUPLICATE_Q = "duplicate";

function questionsFor(recentDiagnosed: string[]): Record<string, NoulQuestion> {
	const questions: Record<string, NoulQuestion> = {
		[ROUTINE_Q]: {
			type: "noul",
			instructions:
				"Is `finding` a routine, expected operational event -- a normal deployment, an autoscaling action, or scheduled maintenance -- rather than a problem that needs an engineer to investigate?",
		},
	};
	// Only ask the duplicate question when there is something to compare against.
	// Asking it against an empty list invites an answer with nothing behind it.
	if (recentDiagnosed.length > 0) {
		questions[DUPLICATE_Q] = {
			type: "noul",
			instructions: "Does `finding` describe the same underlying failure as any entry in `recent_diagnosed`?",
		};
	}
	return questions;
}

/**
 * Score each finding. One request per finding, in parallel: the judgement is
 * about one finding against the recent context, and batching them into a single
 * state would make every other finding a distractor.
 *
 * Returns only the findings that were successfully judged. A finding missing
 * from the map is investigated as today, so a partial result degrades safely
 * rather than silently skipping something unjudged.
 */
export async function judgeActionability(
	findings: Finding[],
	recentDiagnosed: string[],
	deps: { apiKey: string; ask?: typeof askSystemOne; signal?: AbortSignal },
): Promise<Map<string, ActionabilityVerdict>> {
	const verdicts = new Map<string, ActionabilityVerdict>();
	if (findings.length === 0) return verdicts;
	const ask = deps.ask ?? askSystemOne;
	const signal = deps.signal ?? AbortSignal.timeout(JUDGE_DEADLINE_MS);
	const recent = recentDiagnosed.slice(0, RECENT_CONTEXT);
	const questions = questionsFor(recent);

	// allSettled, not all: unlike the Atlassian rerank (where a partial ranking
	// would read as ranked while being arbitrary) each verdict here stands alone,
	// and one failure must not discard the others' judgements.
	const results = await Promise.allSettled(
		findings.map((finding) =>
			ask({
				state: {
					finding: {
						family: finding.family,
						severity: finding.severity,
						resource: finding.resource,
						summary: finding.summary,
					},
					...(recent.length > 0 ? { recent_diagnosed: recent } : {}),
				},
				questions,
				apiKey: deps.apiKey,
				signal,
			}),
		),
	);

	for (const [i, result] of results.entries()) {
		if (result.status !== "fulfilled") continue;
		const finding = findings[i];
		if (!finding) continue;
		const routine = result.value.answers[ROUTINE_Q]?.noul;
		// No routine answer means the question we gate on was not answered; treat
		// the whole verdict as missing rather than defaulting it to 0.
		if (routine === undefined) continue;
		verdicts.set(finding.dedup_key, {
			routine,
			duplicate: result.value.answers[DUPLICATE_Q]?.noul ?? 0,
		});
	}
	return verdicts;
}

export { resolveTypeSafeApiKey };

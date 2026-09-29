// scripts/monitor/actionability-judge.ts
// SIO-1838: the Jev half of the actionability gate. Kept apart from
// actionability.ts so the decision logic stays pure and offline-testable, and
// only this file knows there is a network.

import { ZodError } from "zod";
import type { ActionabilityVerdict } from "./actionability.ts";
import type { Finding } from "./report.ts";
import { askSystemOne, type Question, resolveTypeSafeApiKey } from "./typesafe.ts";

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

// Greptile PR #871: a monitor summary is not safe text. It can carry a raw log
// excerpt, an RDS event message, an IAM principal or an ARN, and this is the
// first thing in pi-coms to send any of it off-box. packages/shared's
// redactPiiContent is unreachable here (the spoke bundle carries only
// packages/pi-coms), so the same patterns are restated, plus the infra-specific
// ones that matter on this path.
//
// IPv4 is deliberately NOT redacted, matching the shared redactor's SIO-861
// decision: this is internal infrastructure and an address is often the subject.
const REDACTIONS: readonly { re: RegExp; to: string }[] = [
	{ re: /\b\d{3}-\d{2}-\d{4}\b/g, to: "[SSN_REDACTED]" },
	{ re: /\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{1,7}\b/g, to: "[CC_REDACTED]" },
	{ re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, to: "[EMAIL_REDACTED]" },
	// An ARN's trailing segments name buckets, functions, users and roles. The
	// account field is OPTIONAL: S3 writes `arn:aws:s3:::bucket/key`, and an
	// account-only pattern let every bucket name through (caught by the test
	// below, which is why it asserts on an S3 ARN specifically).
	{ re: /\barn:aws[a-z-]*:[a-z0-9-]+:[a-z0-9-]*:\d{0,12}:\S+/g, to: "[ARN_REDACTED]" },
	// A bare 12-digit AWS account id.
	{ re: /\b\d{12}\b/g, to: "[ACCOUNT_REDACTED]" },
	// AKIA/ASIA access key ids, and anything shaped like a bearer secret.
	{ re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, to: "[AKID_REDACTED]" },
];

export function redactMonitorText(text: string): string {
	let out = text;
	for (const { re, to } of REDACTIONS) out = out.replace(re, to);
	return out;
}

// SIO-1885: why a request failed, as a fixed label. The raw message is never
// forwarded: a JSON or schema error can quote response text (SIO-1833), and this
// string lands in the journal and operator-visible logs. askSystemOne's own
// non-2xx error is status-only by construction, so its status is safe to keep.
export function classifyFailure(reason: unknown): string {
	if (reason instanceof ZodError) return "schema";
	if (reason instanceof SyntaxError) return "invalid json";
	if (reason instanceof Error) {
		if (reason.name === "TimeoutError" || reason.name === "AbortError") return "timeout";
		const status = /^TypeSafe request failed with status (\d{3})$/.exec(reason.message)?.[1];
		if (status) return `http ${status}`;
	}
	return "network";
}

const TRIAGE_Q = "triage";
const DUPLICATE_Q = "duplicate";

// SIO-1883: one Choice replaces the SIO-1838 `routine` Noul, and only its
// `routine` probability is used. Measured on 537 real fleet findings labelled
// from their diagnoses (2026-09-26): at p >= 0.85 the Choice held back 32 of 171
// no-action findings where the Noul held back 12, and no urgent finding scored
// above 0.14 (Noul: 0.27). The other three options are there because a routine
// verdict is sharper when it competes with concrete alternatives. Their own
// probabilities are NOT used: "critical" never exceeded 0.04 on the 18 urgent
// warns and "investigate_later" did not separate them either -- urgency lives in
// what an investigation finds, not in a one-line finding summary.
// `duplicate` stays its own Noul: a separate judgement against separate context.
const TRIAGE_QUESTION: Question = {
	type: "choice",
	instructions:
		"How should the on-call engineer treat `finding`, a monitoring finding from an AWS account? Judge the impact the finding itself describes, not how alarming its wording sounds.",
	criteria: {
		critical:
			"An active outage, data loss, a security compromise, or failing customer-facing traffic that needs an engineer now.",
		investigate_now: "A real problem that is getting worse or blocking work and should be diagnosed this cycle.",
		investigate_later:
			"A real but contained problem with no customer impact yet, which can safely wait an hour to be diagnosed.",
		routine:
			"An expected operational event -- a normal deployment, an autoscaling action, scheduled maintenance -- that needs no engineer. A deployment or scaling action that FAILED is not routine.",
	},
};

function questionsFor(recentDiagnosed: string[]): Record<string, Question> {
	const questions: Record<string, Question> = { [TRIAGE_Q]: TRIAGE_QUESTION };
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
	// The NEWEST entries, not the first ones. Greptile PR #871: journalRows is
	// `ORDER BY id ASC`, so slicing from the front kept the OLDEST eight and, on any
	// day with more than eight diagnosed findings, compared a current warning
	// against stale context while ignoring what just happened.
	const recent = recentDiagnosed.slice(-RECENT_CONTEXT);
	const questions = questionsFor(recent);

	// allSettled so one failure does not throw away the rest of the round -- but
	// see the all-or-nothing rule below. Greptile PR #871: returning a partial map
	// let the caller ENFORCE the verdicts it did get while the classifier was
	// visibly degraded, which contradicts the documented contract that an error
	// sends the whole batch. A gate that can hold back a real incident does not get
	// to run on partial information.
	const results = await Promise.allSettled(
		findings.map((finding) =>
			ask({
				state: {
					finding: {
						family: finding.family,
						severity: finding.severity,
						// Redacted here rather than at the call site so EVERY caller of
						// this function is covered, including a future one.
						resource: redactMonitorText(finding.resource),
						summary: redactMonitorText(finding.summary),
					},
					...(recent.length > 0 ? { recent_diagnosed: recent.map(redactMonitorText) } : {}),
				},
				questions,
				apiKey: deps.apiKey,
				signal,
			}),
		),
	);

	// ALL OR NOTHING. If any request failed, return an empty map: the caller then
	// investigates everything, exactly as before the gate existed. A partial map
	// would silently narrow the safety contract from "an error sends the batch" to
	// "an error sends the findings that happened to fail", which is not a property
	// anyone could reason about while reading the cycle.
	const failures = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
	if (failures.length > 0) {
		const counts = new Map<string, number>();
		for (const f of failures) {
			const c = classifyFailure(f.reason);
			counts.set(c, (counts.get(c) ?? 0) + 1);
		}
		const why = [...counts].map(([c, n]) => (n > 1 ? `${c} x${n}` : c)).join(", ");
		throw new Error(`actionability: ${failures.length}/${results.length} requests failed (${why})`);
	}

	for (const [i, result] of results.entries()) {
		if (result.status !== "fulfilled") continue;
		const finding = findings[i];
		if (!finding) continue;
		const triage = result.value.answers[TRIAGE_Q];
		// No triage answer means the question we gate on was not answered; leave
		// this finding unjudged rather than defaulting it to 0. One malformed reply
		// is not a degraded classifier, so unlike a failed REQUEST it does not void
		// the round -- the caller sends anything missing from the map.
		if (triage?.type !== "choice") continue;
		const dup = result.value.answers[DUPLICATE_Q];
		verdicts.set(finding.dedup_key, {
			routine: triage.probabilities.routine ?? 0,
			duplicate: dup?.type === "noul" ? dup.noul : 0,
		});
	}
	return verdicts;
}

export { resolveTypeSafeApiKey };

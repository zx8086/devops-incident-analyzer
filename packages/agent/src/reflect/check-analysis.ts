// packages/agent/src/reflect/check-analysis.ts
//
// SIO-1834 (A4): the report gate. Catches a report that is malformed or that asserts
// something its own evidence does not support. Exit 0 clean, 1 violations, 2 usage error --
// the convention wiki:lint and eval:spec-audit already follow.
import { ANALYSIS_SCHEMA_ID, AnalysisSchema, MIN_RECURRENCE } from "./aggregate.ts";

export interface Violation {
	rule: string;
	detail: string;
}

export function lintAnalysis(raw: unknown): Violation[] {
	const parsed = AnalysisSchema.safeParse(raw);
	if (!parsed.success) {
		return [
			{ rule: "bad-schema", detail: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") },
		];
	}
	const analysis = parsed.data;
	const violations: Violation[] = [];

	if (analysis.schema !== ANALYSIS_SCHEMA_ID) {
		violations.push({ rule: "bad-schema", detail: `schema is "${analysis.schema}"` });
	}

	// An empty window is a real answer, but it is not a report anyone should act on, and a
	// silent pass would let a broken adapter look like a clean week.
	if (analysis.stats.sessions < 1) {
		violations.push({ rule: "no-evidence", detail: "window contains no sessions" });
	}

	for (const finding of analysis.findings) {
		if (finding.recurrence < MIN_RECURRENCE) {
			violations.push({
				rule: "finding-recurrence",
				detail: `${finding.id} recurs in ${finding.recurrence} session(s), below the ${MIN_RECURRENCE} bar`,
			});
		}
		// Evidence or silence: a finding with no quotable evidence cannot be verified, so it
		// must not be in the report at all.
		if (finding.evidence.length === 0) {
			violations.push({ rule: "finding-evidence", detail: `${finding.id} carries no evidence` });
		}
		if (finding.sessions.length !== finding.recurrence) {
			violations.push({
				rule: "finding-sessions",
				detail: `${finding.id} lists ${finding.sessions.length} sessions but claims recurrence ${finding.recurrence}`,
			});
		}
		for (const item of finding.evidence) {
			if (!finding.sessions.includes(item.session)) {
				violations.push({
					rule: "finding-evidence-session",
					detail: `${finding.id} cites run ${item.session}, which is not among its own sessions`,
				});
			}
		}
	}

	for (const item of analysis.portfolio) {
		if (!item.reason.trim()) {
			violations.push({ rule: "portfolio-reason", detail: `${item.id} has no reason` });
		}
		if (item.recurrence < MIN_RECURRENCE) {
			violations.push({
				rule: "portfolio-recurrence",
				detail: `${item.id} recurs in ${item.recurrence} session(s), below the ${MIN_RECURRENCE} bar`,
			});
		}
	}

	if (analysis.stats.findings !== analysis.findings.length) {
		violations.push({
			rule: "stats-drift",
			detail: `stats.findings=${analysis.stats.findings} but ${analysis.findings.length} findings present`,
		});
	}
	if (analysis.stats.portfolio !== analysis.portfolio.length) {
		violations.push({
			rule: "stats-drift",
			detail: `stats.portfolio=${analysis.stats.portfolio} but ${analysis.portfolio.length} items present`,
		});
	}

	// A window whose reaction detectors could not fire MUST say so, or its silence reads as
	// "no quality problems found" (measured: 1 of 35 sessions was multi-turn).
	if (analysis.stats.sessions > 0 && analysis.stats.multiTurnSessions === 0 && analysis.notes.length === 0) {
		violations.push({
			rule: "unstated-blind-spot",
			detail: "no multi-turn session in the window, but the report does not say the quality lane was starved",
		});
	}

	return violations;
}

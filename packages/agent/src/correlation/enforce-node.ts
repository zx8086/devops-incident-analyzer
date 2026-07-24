// agent/src/correlation/enforce-node.ts
import { getLogger } from "@devops-agent/observability";
import { Send } from "@langchain/langgraph";
import { GAPS_BULLET_THRESHOLD, rewriteConfidenceInAnswer } from "../aggregator";
import { deriveConfidenceCap, getConfidenceThreshold } from "../confidence-gate";
import {
	CAP_REASON_CLASS,
	type CoverageSignal,
	decideConfidenceCap,
	isCoverageScopingEnabled,
	upsertCoverageNote,
	upsertIntegrityNote,
} from "../confidence-policy.ts";
import type { AgentStateType, DegradedRule, PendingCorrelation } from "../state";
import { queryDataSource } from "../sub-agent";
import { evaluate } from "./engine";
import { type CorrelationRule, correlationRules, LOG_GAP_RULE_NAME, LogGapTriggerContextSchema } from "./rules";

const logger = getLogger("agent:enforceCorrelations");

// SIO-1076: per-rule top-of-report banners for degraded skipCoverageCheck rules.
// Keyed by rule name so each self-signalling rule reads correctly (a security
// vuln must not read as a deploy contradiction), and so multiple distinct rules
// degrading in one run each get their own banner instead of one silently
// winning. An UNMAPPED skipCoverageCheck rule gets no banner (rather than a
// misleading deploy-contradiction default) -- its cap still applies.
const BANNER_BY_RULE_NAME: Record<string, (cap: number) => string> = {
	"gitlab-deploy-vs-datastore-runtime": (cap) =>
		`WARNING: unresolved cross-source contradiction -- a deployment was reported but the buggy behaviour was observed afterward. Confidence capped to ${cap}. See the Gaps and Findings sections below.`,
	"orbit-vuln-introduced-by-recent-mr": (cap) =>
		`WARNING: a critical/high security vulnerability was detected on an affected project during this incident. Confidence capped to ${cap}. Review the Findings section and remediate independently of the root cause.`,
};

function bannerForDegraded(degraded: DegradedRule[], cap: number): string | undefined {
	const banners = new Set<string>();
	for (const d of degraded) {
		const ruleDef = correlationRules.find((r) => r.name === d.ruleName);
		if (ruleDef?.skipCoverageCheck !== true) continue;
		const build = BANNER_BY_RULE_NAME[d.ruleName];
		if (build) banners.add(build(cap));
	}
	return banners.size > 0 ? [...banners].join("\n\n") : undefined;
}

export function enforceCorrelationsRouter(state: AgentStateType): Send[] | "enforceCorrelationsAggregate" {
	const decisions = evaluate(state, correlationRules);
	const needsInvocation = decisions.filter((d) => d.status === "needs-invocation");

	if (needsInvocation.length === 0) {
		logger.info({ rulesEvaluated: decisions.length }, "No correlation rules require invocation");
		return "enforceCorrelationsAggregate";
	}

	const sends: Send[] = [];

	// SIO-712: rules with skipCoverageCheck=true are self-signalling -- the trigger
	// itself is the contradiction signal and there's nothing useful to refetch.
	// Route them directly to enforceCorrelationsAggregate with pendingCorrelations
	// pre-populated so the cap path runs without an extra sub-agent invocation.
	const skipCoverageDecisions = needsInvocation.filter((d) => d.rule.skipCoverageCheck === true);
	if (skipCoverageDecisions.length > 0) {
		const skipCoveragePendings: PendingCorrelation[] = skipCoverageDecisions.map((d) => ({
			ruleName: d.rule.name,
			requiredAgent: d.rule.requiredAgent,
			triggerContext: d.match?.context ?? {},
			attemptsRemaining: d.rule.retry.attempts,
			timeoutMs: d.rule.retry.timeoutMs,
		}));
		sends.push(
			new Send("enforceCorrelationsAggregate", {
				...state,
				pendingCorrelations: skipCoveragePendings,
				// CodeRabbit (PR #419): explicitly clear the transient directive on every
				// Send so no spread can carry a stale instruction between rounds.
				correlationFetchDirective: undefined,
			}),
		);
	}

	// Regular rules go through the refetch path (existing behaviour).
	// Dedupe by required agent: collapse multiple rules requiring the same agent into one Send.
	const regularDecisions = needsInvocation.filter((d) => d.rule.skipCoverageCheck !== true);
	const dedupedByAgent = new Map<string, PendingCorrelation[]>();
	for (const d of regularDecisions) {
		const key = d.rule.requiredAgent;
		const existing = dedupedByAgent.get(key) ?? [];
		existing.push({
			ruleName: d.rule.name,
			requiredAgent: d.rule.requiredAgent,
			triggerContext: d.match?.context ?? {},
			attemptsRemaining: d.rule.retry.attempts,
			timeoutMs: d.rule.retry.timeoutMs,
		});
		dedupedByAgent.set(key, existing);
	}

	for (const [agent, pendings] of dedupedByAgent.entries()) {
		const dataSourceId = agent.replace(/-agent$/, "");
		// SIO-1155: rules may provide a targeted fetch directive; without one the
		// refetch re-runs the original incident prompt and rarely covers the rule's
		// entities. Multiple directives for one agent concatenate.
		const directives = pendings
			.map((p) => {
				const ruleDef = correlationRules.find((r) => r.name === p.ruleName);
				return ruleDef?.fetchDirective?.(p.triggerContext);
			})
			.filter((d): d is string => typeof d === "string" && d.length > 0);
		sends.push(
			new Send("correlationFetch", {
				...state,
				currentDataSource: dataSourceId,
				pendingCorrelations: pendings,
				// CodeRabbit (PR #419): always set (never conditionally spread) so a Send
				// without directives cannot inherit a stale one.
				correlationFetchDirective: directives.length > 0 ? directives.join("\n\n") : undefined,
			}),
		);
	}

	logger.info(
		{
			ruleCount: needsInvocation.length,
			// SIO-1155: name the dispatched rules -- "ruleCount: 1" alone cannot be
			// verified against a live run.
			ruleNames: needsInvocation.map((d) => d.rule.name),
			sendCount: sends.length,
			skipCoverageCount: skipCoverageDecisions.length,
			regularCount: regularDecisions.length,
		},
		"Correlation rules require dispatch; routing",
	);
	return sends;
}

// SIO-1155: after a satisfied log-gap fetch, the recovered Gaps bullets get an
// explicit recovery clause (which also exempts them from the SIO-1149 classifier on
// any later re-parse) and, when the gaps cap was the aggregate's SOLE cap reason and
// the judge-confirmed remainder falls below the threshold, the pre-cap confidence is
// restored. Any other cap reason, or a still-degraded rule, wins over restoration.
const RECOVERED_BULLET_SUFFIX =
	" -- recovered via elastic (post-report correlation fetch; see the elastic datasource findings)";

interface LogGapRecovery {
	answer: string;
	recoveredBullets: string[];
	restoredScore?: number;
}

function computeLogGapRecovery(state: AgentStateType, degraded: DegradedRule[]): LogGapRecovery | null {
	const pending = state.pendingCorrelations.find((p) => p.ruleName === LOG_GAP_RULE_NAME);
	if (!pending || !state.finalAnswer) return null;
	// Fetch did not cover the services: the normal degraded-cap path handles it.
	if (degraded.some((d) => d.ruleName === LOG_GAP_RULE_NAME)) return null;
	// CodeRabbit (PR #419): both consumers of the trigger context parse one schema.
	const parsedContext = LogGapTriggerContextSchema.safeParse(pending.triggerContext);
	if (!parsedContext.success) return null;
	const bullets = parsedContext.data.bullets;
	if (bullets.length === 0) return null;

	const flagged = new Set(bullets);
	const answer = state.finalAnswer
		.split("\n")
		.map((line) =>
			flagged.has(line) && !line.includes("recovered via elastic") ? line + RECOVERED_BULLET_SUFFIX : line,
		)
		.join("\n");

	let restoredScore: number | undefined;
	// Restoration requires: no OTHER rule degraded this round (their cap would win),
	// the gaps cap was the aggregate's sole cap reason, and subtracting the recovered
	// bullets drops the judge-confirmed count below the threshold. The ?? [] guards
	// cover checkpoints resumed from graph versions predating these channels.
	const capReasons = state.capReasons ?? [];
	const soleGapsCap = capReasons.length === 1 && capReasons[0] === "gaps";
	if (
		degraded.length === 0 &&
		soleGapsCap &&
		typeof state.confidencePreCap === "number" &&
		state.confidencePreCap > state.confidenceScore
	) {
		const remaining = (state.confirmedDegradingGapBullets ?? []).filter((b) => !flagged.has(b));
		if (remaining.length < GAPS_BULLET_THRESHOLD) restoredScore = state.confidencePreCap;
	}

	// SIO-1194: "strip" removes the aggregate's stale cap annotation -- a restored
	// score must not read "(capped from ...)" next to the recovered value.
	// SIO-1195: the coverage note goes with it (the sole "gaps" reason was cured).
	const rewritten =
		restoredScore !== undefined
			? rewriteConfidenceInAnswer(upsertIntegrityNote(upsertCoverageNote(answer, null), null), restoredScore, "strip")
			: answer;
	logger.info(
		{ recoveredBullets: bullets.length, restored: restoredScore !== undefined, restoredScore },
		"log-gap correlation fetch recovered report gaps",
	);
	return { answer: rewritten, recoveredBullets: bullets, restoredScore };
}

// SIO-1195 (CodeRabbit PR #456): pure + exported for unit tests -- a real soft
// correlation needs a rule declaring relevanceDataSources, which no production
// rule does in v1, so the seam is tested with a synthetic rules array instead of
// mocking the rules module.
export function correlationCoverageSignals(
	degraded: DegradedRule[],
	rules: ReadonlyArray<Pick<CorrelationRule, "name" | "relevanceDataSources">>,
): CoverageSignal[] {
	return degraded.map((d) => ({
		reason: "correlation-degraded",
		dataSources: rules.find((r) => r.name === d.ruleName)?.relevanceDataSources ?? null,
	}));
}

export async function enforceCorrelationsAggregate(state: AgentStateType): Promise<Partial<AgentStateType>> {
	if (state.pendingCorrelations.length === 0) {
		return { degradedRules: [], confidenceCap: undefined };
	}

	const decisions = evaluate(state, correlationRules);
	const degraded: DegradedRule[] = [];

	for (const pending of state.pendingCorrelations) {
		const decision = decisions.find((d) => d.rule.name === pending.ruleName);
		if (!decision || decision.status === "satisfied") continue;
		const reason =
			decision.rule.skipCoverageCheck === true
				? "unresolved cross-source contradiction"
				: "specialist invoked but findings did not cover the triggered entities (or invocation failed upstream)";
		degraded.push({
			ruleName: pending.ruleName,
			requiredAgent: pending.requiredAgent,
			reason,
			triggerContext: pending.triggerContext,
		});
	}

	const recovery = computeLogGapRecovery(state, degraded);

	if (degraded.length === 0) {
		logger.info("All pending correlations satisfied after re-fan-out");
		return {
			degradedRules: [],
			confidenceCap: undefined,
			pendingCorrelations: [],
			correlationFetchDirective: undefined,
			...(recovery && { finalAnswer: recovery.answer }),
			...(recovery?.restoredScore !== undefined && { confidenceScore: recovery.restoredScore }),
			// SIO-1194: a restore means the sole cap reason ("gaps") is cured -- clear
			// capReasons so the SSE last-writer capture reports the run as uncapped.
			// Without a restore the aggregate's capReasons must stand untouched.
			...(recovery?.restoredScore !== undefined && { capReasons: [] }),
		};
	}

	// SIO-709 AC #4: cap must be strictly below the HITL threshold so a capped run
	// does not pass the gate. SIO-1194: threshold-derived (0.59 at the default 0.6).
	// SIO-1195: correlation degradation is coverage-class -- soft-eligible only when
	// every degraded rule declares relevanceDataSources disjoint from the root-cause
	// evidence (v1: no rule declares it, so this path always resolves hard).
	// skipCoverageCheck rules (contradiction/security) are integrity-adjacent and
	// always hard. Signals for the aggregate's own coverage reasons are re-supplied
	// from state only when the aggregate itself verified them (soft mode) -- a prior
	// hard cap stays hard.
	const anySkipCoverage = degraded.some(
		(d) => correlationRules.find((r) => r.name === d.ruleName)?.skipCoverageCheck === true,
	);
	const mergedReasons = [...new Set([...(state.capReasons ?? []), "correlation-degraded"])];
	const coverageSignals: CoverageSignal[] = correlationCoverageSignals(degraded, correlationRules);
	for (const reason of state.capReasons ?? []) {
		if (CAP_REASON_CLASS[reason] !== "coverage") continue;
		coverageSignals.push({
			reason,
			dataSources:
				state.confidenceCapMode === "soft" && (state.degradedDataSources ?? []).length > 0
					? state.degradedDataSources
					: null,
		});
	}
	const decision =
		anySkipCoverage || !isCoverageScopingEnabled(process.env)
			? null
			: decideConfidenceCap({
					capReasons: mergedReasons,
					coverageSignals,
					rootCauseDataSources: state.rootCauseDataSources ?? null,
					threshold: getConfidenceThreshold(),
				});
	const capMode: "hard" | "soft" = decision?.mode === "soft" ? "soft" : "hard";
	const cap = capMode === "soft" && decision?.cap !== undefined ? decision.cap : deriveConfidenceCap();
	const cappedScore = Math.min(state.confidenceScore, cap);
	logger.warn(
		{ degradedCount: degraded.length, cap, capMode, originalScore: state.confidenceScore, cappedScore },
		"One or more correlation rules degraded; capping confidence",
	);

	// SIO-712 / SIO-1076: when a skipCoverageCheck rule degraded, prepend a
	// top-of-report banner so the human reader sees the warning before any prose.
	// The HITL gate already catches the cap, but the banner makes the signal
	// visible even if a reader skims past the confidence number. The banner text
	// is per-rule so a security vuln reads as security, not as a deploy
	// contradiction.
	const bannerText = bannerForDegraded(degraded, cap);
	// SIO-860: rewrite the printed confidence to the capped value so the report prose
	// matches the gate's confidenceScore. Compose with (not replace) the banner,
	// which is prepended above the rewritten body.
	// SIO-1155: when the log-gap rule recovered its bullets while OTHER rules degraded,
	// keep the bullet annotations but let the degraded cap win on the score.
	// SIO-1194: merge correlation-degraded into the aggregate's capReasons and
	// re-annotate the printed line (strip-before-append keeps a single annotation);
	// echo confidencePreCap so this node's output is self-contained for SSE capture.
	// SIO-1195: a hard re-cap over an aggregate soft cap removes the coverage note
	// (prose must never claim moderation next to a below-gate score).
	const preCap = state.confidencePreCap ?? state.confidenceScore;
	const rawBase = recovery?.answer ?? state.finalAnswer;
	const baseAnswer =
		rawBase !== undefined && capMode === "hard"
			? upsertIntegrityNote(upsertCoverageNote(rawBase, null), null)
			: rawBase;
	let updatedFinalAnswer = baseAnswer
		? rewriteConfidenceInAnswer(baseAnswer, cappedScore, { preCap, capReasons: mergedReasons })
		: undefined;
	// SIO-1195 (CodeRabbit PR #456): a soft correlation cap explains itself like the
	// aggregate's soft path does (upsert replaces any prior note). Unreachable until
	// a rule declares relevanceDataSources, but implemented now so opting a rule in
	// cannot create a prose/state divergence.
	if (capMode === "soft" && updatedFinalAnswer && (state.rootCauseDataSources ?? []).length > 0) {
		updatedFinalAnswer = upsertCoverageNote(
			updatedFinalAnswer,
			`cross-source correlation degradation affected ${(decision?.degradedDataSources ?? []).join(", ")}, which did not supply the root-cause evidence (${(state.rootCauseDataSources ?? []).join(", ")}); confidence was moderated rather than capped below the review threshold.`,
		);
	}
	if (bannerText && updatedFinalAnswer) {
		updatedFinalAnswer = `${bannerText}\n\n${updatedFinalAnswer}`;
	}

	return {
		degradedRules: degraded,
		confidenceCap: cap,
		confidenceScore: cappedScore,
		capReasons: mergedReasons,
		confidencePreCap: preCap,
		confidenceCapMode: capMode,
		pendingCorrelations: [],
		correlationFetchDirective: undefined,
		...(updatedFinalAnswer !== undefined && { finalAnswer: updatedFinalAnswer }),
	};
}

// SIO-1155 (fixes a latent SIO-681 gap surfaced by the live replay): pendingCorrelations
// arrive at correlationFetch via the Send ARGS -- the task input -- and Send args are NOT
// persisted to the global state unless a node returns them. Without this echo the
// downstream enforceCorrelationsAggregate always read an empty pendingCorrelations and
// silently early-returned, making the entire re-evaluate-after-fetch path (rule
// satisfaction, degradation cap, and the SIO-1155 recovery) a no-op in production.
// Replay evidence: router logged a dispatch, the fetch sub-agent ran, and the aggregate
// logged neither "satisfied" nor "degraded". With parallel Sends the overwrite reducer
// keeps the last writer's list (pre-existing SIO-681 limitation, unchanged here).
export function withPendingEcho(state: AgentStateType, update: Partial<AgentStateType>): Partial<AgentStateType> {
	return { ...update, pendingCorrelations: state.pendingCorrelations };
}

export async function correlationFetch(state: AgentStateType): Promise<Partial<AgentStateType>> {
	return withPendingEcho(state, await queryDataSource(state));
}

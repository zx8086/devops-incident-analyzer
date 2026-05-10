// agent/src/correlation/enforce-node.ts
import { getLogger } from "@devops-agent/observability";
import { Send } from "@langchain/langgraph";
import type { AgentStateType, DegradedRule, PendingCorrelation } from "../state";
import { queryDataSource } from "../sub-agent";
import { evaluate } from "./engine";
import { correlationRules } from "./rules";

const logger = getLogger("agent:enforceCorrelations");

// SIO-709 AC #4: cap must be strictly below the HITL threshold (0.6 from
// confidence-gate.ts) so a capped run does not pass the gate.
const CONFIDENCE_CAP_ON_DEGRADATION = 0.59;

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
		sends.push(
			new Send("correlationFetch", {
				...state,
				currentDataSource: dataSourceId,
				pendingCorrelations: pendings,
			}),
		);
	}

	logger.info(
		{
			ruleCount: needsInvocation.length,
			sendCount: sends.length,
			skipCoverageCount: skipCoverageDecisions.length,
			regularCount: regularDecisions.length,
		},
		"Correlation rules require dispatch; routing",
	);
	return sends;
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

	if (degraded.length === 0) {
		logger.info("All pending correlations satisfied after re-fan-out");
		return { degradedRules: [], confidenceCap: undefined, pendingCorrelations: [] };
	}

	const cap = CONFIDENCE_CAP_ON_DEGRADATION;
	const cappedScore = Math.min(state.confidenceScore, cap);
	logger.warn(
		{ degradedCount: degraded.length, cap, originalScore: state.confidenceScore, cappedScore },
		"One or more correlation rules degraded; capping confidence",
	);

	// SIO-712: when a skipCoverageCheck rule degraded (e.g. cross-source
	// contradiction), prepend a top-of-report banner so the human reader sees
	// the warning before any prose. The HITL gate already catches the cap, but
	// the banner makes the contradiction visible even if a reader skims past
	// the confidence number.
	const hasContradictionRule = degraded.some((d) => {
		const ruleDef = correlationRules.find((r) => r.name === d.ruleName);
		return ruleDef?.skipCoverageCheck === true;
	});
	const updatedFinalAnswer =
		hasContradictionRule && state.finalAnswer
			? `WARNING: unresolved cross-source contradiction -- a deployment was reported but the buggy behaviour was observed afterward. Confidence capped to ${cap}. See the Gaps and Findings sections below.\n\n${state.finalAnswer}`
			: undefined;

	return {
		degradedRules: degraded,
		confidenceCap: cap,
		confidenceScore: cappedScore,
		pendingCorrelations: [],
		...(updatedFinalAnswer !== undefined && { finalAnswer: updatedFinalAnswer }),
	};
}

export async function correlationFetch(state: AgentStateType): Promise<Partial<AgentStateType>> {
	return queryDataSource(state);
}

// agent/src/correlation/enforce-node.ts
import { getLogger } from "@devops-agent/observability";
import { Send } from "@langchain/langgraph";
import type { AgentStateType, DegradedRule, PendingCorrelation } from "../state";
import { queryDataSource } from "../sub-agent";
import { evaluate } from "./engine";
import { correlationRules } from "./rules";

const logger = getLogger("agent:enforceCorrelations");

const CONFIDENCE_CAP_ON_DEGRADATION = 0.6;

export function enforceCorrelationsRouter(state: AgentStateType): Send[] | "enforceCorrelationsAggregate" {
	const decisions = evaluate(state, correlationRules);
	const needsInvocation = decisions.filter((d) => d.status === "needs-invocation");

	if (needsInvocation.length === 0) {
		logger.info({ rulesEvaluated: decisions.length }, "No correlation rules require invocation");
		return "enforceCorrelationsAggregate";
	}

	// Dedupe by required agent: collapse multiple rules requiring the same agent into one Send.
	const dedupedByAgent = new Map<string, PendingCorrelation[]>();
	for (const d of needsInvocation) {
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

	const sends: Send[] = [];
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
		{ ruleCount: needsInvocation.length, sendCount: sends.length },
		"Correlation rules require specialist invocation; dispatching",
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
		degraded.push({
			ruleName: pending.ruleName,
			requiredAgent: pending.requiredAgent,
			reason: "specialist invoked but findings did not cover the triggered entities (or invocation failed upstream)",
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
	return {
		degradedRules: degraded,
		confidenceCap: cap,
		confidenceScore: cappedScore,
		pendingCorrelations: [],
	};
}

export async function correlationFetch(state: AgentStateType): Promise<Partial<AgentStateType>> {
	return queryDataSource(state);
}

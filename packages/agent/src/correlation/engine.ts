// agent/src/correlation/engine.ts
import type { DataSourceResult } from "@devops-agent/shared";
import type { AgentStateType } from "../state";
import type { CorrelationRule, TriggerMatch } from "./rules";

export interface CorrelationDecision {
	rule: CorrelationRule;
	status: "satisfied" | "needs-invocation";
	match: TriggerMatch | null;
	reason: string;
}

export function evaluate(state: AgentStateType, rules: CorrelationRule[]): CorrelationDecision[] {
	return rules.map((rule) => evaluateOne(state, rule));
}

function evaluateOne(state: AgentStateType, rule: CorrelationRule): CorrelationDecision {
	let match: TriggerMatch | null;
	try {
		match = rule.trigger(state);
	} catch (err) {
		return {
			rule,
			status: "satisfied",
			match: null,
			reason: `predicate error (fail-open): ${(err as Error).message}`,
		};
	}
	if (match === null) {
		return { rule, status: "satisfied", match: null, reason: "trigger conditions absent" };
	}
	if (!rule.skipCoverageCheck && alreadyCovered(state, rule, match)) {
		return { rule, status: "satisfied", match, reason: "already covered by prior agent findings" };
	}
	return { rule, status: "needs-invocation", match, reason: "trigger fired; specialist required" };
}

// Idempotency: a rule is already covered if findings exist from the requiredAgent's data source
// referencing at least one of the entities in the trigger context.
function alreadyCovered(state: AgentStateType, rule: CorrelationRule, match: TriggerMatch): boolean {
	const dataSourceId = agentToDataSourceId(rule.requiredAgent);
	const result = state.dataSourceResults.find((r) => r.dataSourceId === dataSourceId);
	if (result?.status !== "success" || !result.data) return false;

	// SIO-1237: hostname-keyed rules are checked against the synthetic monitors actually
	// retrieved, BEFORE the generic fallback below. extractEntityNames reads only
	// groupIds/services/topics, so a `hostnames` context yielded zero entities and fell into
	// the "presence of findings counts as covered" branch -- marking
	// infra-service-degraded-needs-synthetic-cross-check satisfied whenever ANY successful
	// elastic result existed, including one that never touched synthetics-*. The cross-check
	// therefore never dispatched. Substring rather than exact match because url.full is a
	// full URL (https://ksql.prd.../healthcheck), never equal to the bare hostname.
	const triggeredHostnames = extractHostnames(match.context);
	if (triggeredHostnames.length > 0) {
		const targets = syntheticMonitorTargets(result);
		return triggeredHostnames.some((host) => targets.some((target) => target.includes(host)));
	}

	const triggeredEntities = extractEntityNames(match.context);
	if (triggeredEntities.length === 0) {
		// no entity granularity available; presence of findings counts as covered
		return true;
	}
	const data = result.data as { services?: Array<{ name: string }> };
	const knownServices = new Set((data.services ?? []).map((s) => s.name));
	return triggeredEntities.some((name) => knownServices.has(name));
}

// SIO-763: explicit map prevents capella-agent → "capella" mismatch; canonical
// datasource id for the couchbase MCP server is "couchbase".
const AGENT_TO_DATASOURCE: Record<string, string> = {
	"elastic-agent": "elastic",
	"kafka-agent": "kafka",
	"capella-agent": "couchbase",
	"konnect-agent": "konnect",
	"gitlab-agent": "gitlab",
	"atlassian-agent": "atlassian",
	"aws-agent": "aws",
};

export function agentToDataSourceId(agent: string): string {
	return AGENT_TO_DATASOURCE[agent] ?? agent.replace(/-agent$/, "");
}

// SIO-1237: kept separate from extractEntityNames because hostnames are matched by
// substring against monitor URLs, not by exact name against data.services[].
function extractHostnames(context: Record<string, unknown>): string[] {
	if (!Array.isArray(context.hostnames)) return [];
	return context.hostnames.filter((h): h is string => typeof h === "string" && h.length > 0);
}

// The endpoints a synthetic monitor result actually covers. `url` is the monitored
// url.full; `name` is included because a monitor can be named for its endpoint even when
// the URL field is absent from the parsed document.
function syntheticMonitorTargets(result: DataSourceResult): string[] {
	const monitors = result.elasticFindings?.syntheticMonitors ?? [];
	return monitors.flatMap((m) => [m.url, m.name].filter((v): v is string => typeof v === "string"));
}

function extractEntityNames(context: Record<string, unknown>): string[] {
	const names: string[] = [];
	if (Array.isArray(context.groupIds)) {
		for (const x of context.groupIds) if (typeof x === "string") names.push(x);
	}
	// SIO-1076: Orbit regular-dispatch rules (orbit-deploy-blast-radius-vs-elastic,
	// orbit-pipeline-failure-vs-incident) carry the downstream/affected services as
	// context.services[] (string[]). Without reading them here the idempotency check
	// finds no entities and the rule re-fans every pass -- wasted elastic turns.
	if (Array.isArray(context.services)) {
		for (const x of context.services) if (typeof x === "string") names.push(x);
	}
	if (Array.isArray(context.topics)) {
		for (const x of context.topics) {
			if (x && typeof x === "object" && "name" in x && typeof (x as { name: unknown }).name === "string") {
				names.push((x as { name: string }).name);
			}
		}
	}
	return names;
}

// agent/src/topic-shift.ts
//
// SIO-751: detect a topic shift between the investigation focus established
// earlier in the chat session and the current turn's extracted entities. When
// the new turn has zero overlap with the focus (no shared datasources and no
// shared services), we cannot safely continue stitching findings onto the
// existing investigation -- but we also cannot silently start over, because
// the user may have used a pronoun ("the broker") or a synonym that the
// overlap check missed.
//
// The node uses LangGraph's interrupt() to pause execution and surface a
// "continue / fresh" prompt to the UI. The user's decision flows back via
// graph.streamEvents(new Command({ resume: { decision } }), ...) and is
// returned by interrupt() in the resumed invocation.
//
// First HITL gate in the codebase. See SIO-748 plan for context.

import { getLogger } from "@devops-agent/observability";
import type { InvestigationFocus, NormalizedIncident } from "@devops-agent/shared";
import { interrupt } from "@langchain/langgraph";
import type { AgentStateType } from "./state.ts";

const logger = getLogger("agent:topic-shift");

export interface TopicShiftDecision {
	decision: "continue" | "fresh";
}

// Build a fresh focus candidate from the current turn's normalized incident
// and extracted datasources. The "summary" template matches buildInvestigationFocus
// in normalizer.ts so the user sees consistent phrasing.
function buildCandidate(
	state: AgentStateType,
	incident: NormalizedIncident,
	newDatasources: string[],
): InvestigationFocus {
	const services = incident.affectedServices?.map((s) => s.name) ?? [];
	const severity = incident.severity ?? "unspecified";
	const lastMessage = state.messages.at(-1);
	const query = lastMessage ? String((lastMessage as { content: unknown }).content ?? "") : "";
	const querySnippet = query.trim().replace(/\s+/g, " ").slice(0, 80);
	const summary =
		services.length > 0
			? `${severity} investigation of ${services.join(", ")} -- ${querySnippet}`
			: `${severity} investigation -- ${querySnippet}`;

	return {
		services,
		datasources: newDatasources,
		timeWindow: incident.timeWindow,
		summary,
		establishedAtTurn: state.messages.length,
	};
}

// Pure structural overlap. Returns true when the new turn shares no datasource
// AND no service with the focus, AND has named services of its own (a turn
// with no services is a pure-anaphoric follow-up -- never a shift).
function isTopicShift(focus: InvestigationFocus, newDatasources: string[], newServices: string[]): boolean {
	if (newServices.length === 0) return false;
	const dsOverlap = newDatasources.some((d) => focus.datasources.includes(d));
	if (dsOverlap) return false;
	const lowerFocusServices = focus.services.map((s) => s.toLowerCase());
	const svcOverlap = newServices.some((s) => lowerFocusServices.includes(s.toLowerCase()));
	if (svcOverlap) return false;
	return true;
}

export function detectTopicShift(state: AgentStateType): Partial<AgentStateType> {
	const focus = state.investigationFocus;

	// Nothing to compare against -- this is the first turn (no anchor yet) or
	// a non-follow-up. Pass through.
	if (!focus) return {};
	if (!state.isFollowUp) return {};

	const newServices = state.normalizedIncident.affectedServices?.map((s) => s.name) ?? [];
	const newDatasources = state.extractedEntities.dataSources.map((d) => d.id);

	if (!isTopicShift(focus, newDatasources, newServices)) {
		return {};
	}

	const newFocusCandidate = buildCandidate(state, state.normalizedIncident, newDatasources);

	logger.info(
		{
			oldFocusServices: focus.services,
			oldFocusDatasources: focus.datasources,
			newServices,
			newDatasources,
		},
		"Topic shift detected; interrupting graph for user decision",
	);

	// interrupt() throws a GraphInterrupt on first invocation. The SSE handler
	// catches it and surfaces a prompt to the UI. On resume the Command's
	// resume payload is returned by this call.
	const userChoice = interrupt({
		type: "topic_shift",
		oldFocus: focus,
		newFocusCandidate,
		message: `Your previous turns focused on: ${focus.summary}. This message looks unrelated (${newServices.join(", ")} / ${newDatasources.join(", ")}). Continue with prior context, or treat as a fresh investigation?`,
	}) as TopicShiftDecision;

	if (userChoice.decision === "fresh") {
		logger.info(
			{ newFocusServices: newFocusCandidate.services },
			"User chose 'fresh' -- replacing investigation focus",
		);
		return {
			investigationFocus: newFocusCandidate,
			// Wipe the prior answer so the aggregator does not stitch the new
			// investigation onto an unrelated report.
			finalAnswer: "",
			pendingTopicShiftPrompt: undefined,
		};
	}

	logger.info("User chose 'continue' -- preserving investigation focus");
	return { pendingTopicShiftPrompt: undefined };
}

// Exported for unit tests so they can exercise the structural overlap logic
// without dispatching through the graph and going through interrupt().
export const _testOnly = { buildCandidate, isTopicShift };
